// The filter over one table: conditions joined by AND or OR, edited as a draft and
// applied with Apply. Each condition picks a column, an operator its type allows and a
// value; text columns with few values in scope offer them. The applied filter is shown
// as the SQL WHERE clause it compiles to.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ARITY,
  type Combinator,
  compileFilter,
  type DraftCondition,
  distinctValuesSql,
  kindOf,
  operatorsFor,
  type PackageTable,
  parseFilter,
  type ScopeChunk,
} from "@/core";
import { withEngine } from "@/engine/session";
import { ensureColumns } from "@/features/selection/attributes";
import { useSelection } from "@/features/selection/store";
import { ColumnTypeIcon } from "./ColumnTypeIcon";
import {
  addCondition,
  applyDraft,
  clearFilter,
  setDraft,
  type TableView,
  tableColumns,
} from "./store";

/** Text columns with at most this many values in scope offer them as suggestions. */
const FEW_VALUES = 20;

function ColumnPicker({
  table,
  value,
  label,
  onPick,
}: {
  table: PackageTable;
  value: string;
  label: string;
  onPick: (column: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const columns = tableColumns(table);
  const matches = columns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const current = columns.find((c) => c.name === value);
  const pick = (name: string) => {
    onPick(name);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" aria-label={label} className="max-w-56 justify-start">
          {current && <ColumnTypeIcon kind={kindOf(current.type)} type={current.type} />}
          <span className="truncate">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-2">
        <Input
          autoFocus
          aria-label="Search columns"
          placeholder="Search columns"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const first = matches[0];
            if (e.key === "Enter" && first) pick(first.name);
          }}
        />
        <div role="listbox" aria-label="Columns" className="flex max-h-64 flex-col overflow-y-auto">
          {matches.map((c) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={c.name === value}
              onClick={() => pick(c.name)}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-foreground hover:bg-muted aria-selected:bg-accent"
            >
              <ColumnTypeIcon kind={kindOf(c.type)} type={c.type} />
              <span className="truncate">{c.name}</span>
              <span className="ml-auto shrink-0 truncate text-muted-foreground">{c.type}</span>
            </button>
          ))}
          {matches.length === 0 && <p className="p-1.5">No column matches.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A value box; for a text column it offers the scope's values when there are few. */
function ValueInput({
  label,
  value,
  onChange,
  onEnter,
  suggest,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  suggest: (() => Promise<string[]>) | null;
  placeholder: string;
  type: string;
}) {
  const [values, setValues] = useState<string[]>([]);
  const list = `${label.replaceAll(" ", "-")}-values`;
  return (
    <>
      <Input
        aria-label={label}
        className="w-36"
        value={value}
        placeholder={placeholder}
        inputMode={type === "number" ? "decimal" : undefined}
        list={suggest && values.length > 0 ? list : undefined}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          suggest?.().then(setValues, () => setValues([]));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
        }}
      />
      {suggest && values.length > 0 && (
        <datalist id={list}>
          {values.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      )}
    </>
  );
}

function ConditionRow({
  table,
  view,
  condition,
  index,
  scope,
}: {
  table: PackageTable;
  view: TableView;
  condition: DraftCondition;
  index: number;
  scope: readonly ScopeChunk[];
}) {
  const n = index + 1;
  const column = table.columns.find((c) => c.name === condition.column);
  const kind = kindOf(column?.type ?? "");
  const ops = operatorsFor(kind);
  const arity = ARITY[condition.op];
  const error = view.errors[condition.id];
  const replace = (next: DraftCondition | null) =>
    setDraft(table.name, {
      ...view.draft,
      conditions: view.draft.conditions.flatMap((c) =>
        c.id !== condition.id ? [c] : next ? [next] : [],
      ),
    });
  const apply = () => applyDraft(table);
  const suggest =
    kind === "text" && arity === "one" && scope.length > 0
      ? async () => {
          await ensureColumns(scope, [condition.column]);
          const rows = await withEngine((e) =>
            e.query(distinctValuesSql(scope, condition.column, FEW_VALUES + 1)),
          );
          return rows.length <= FEW_VALUES ? rows.map((r) => String(r.v)) : [];
        }
      : null;
  const placeholder = kind === "date" ? "2024-12-31" : kind === "number" ? "number" : "value";
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-10 shrink-0 text-right text-muted-foreground">
          {index === 0 ? "Where" : view.draft.combinator}
        </span>
        <ColumnPicker
          table={table}
          value={condition.column}
          label={`Column of condition ${n}`}
          onPick={(name) => {
            const type = table.columns.find((c) => c.name === name)?.type ?? "";
            const allowed = operatorsFor(kindOf(type));
            replace({
              ...condition,
              column: name,
              op: allowed.some((o) => o.op === condition.op)
                ? condition.op
                : (allowed[0]?.op ?? "isNull"),
            });
          }}
        />
        <NativeSelect
          aria-label={`Operator of condition ${n}`}
          value={condition.op}
          onChange={(e) => replace({ ...condition, op: e.target.value as DraftCondition["op"] })}
        >
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
        {arity !== "none" && (
          <ValueInput
            label={`Value of condition ${n}`}
            value={condition.value}
            placeholder={arity === "list" ? "a, b, c" : placeholder}
            type={kind}
            suggest={suggest}
            onChange={(value) => replace({ ...condition, value })}
            onEnter={apply}
          />
        )}
        {arity === "two" && (
          <>
            <span>and</span>
            <ValueInput
              label={`Second value of condition ${n}`}
              value={condition.value2}
              placeholder={placeholder}
              type={kind}
              suggest={null}
              onChange={(value2) => replace({ ...condition, value2 })}
              onEnter={apply}
            />
          </>
        )}
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Remove condition ${n}`}
          title="Remove this condition"
          onClick={() => replace(null)}
        >
          Remove
        </Button>
      </div>
      {error && (
        <p role="alert" className="pl-11.5 text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function FilterBar({
  table,
  view,
  scope,
}: {
  table: PackageTable;
  view: TableView;
  scope: readonly ScopeChunk[];
}) {
  const applied = useSelection((s) => s.filters[table.name] ?? null);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);
  const where = applied ? `WHERE ${compileFilter(applied)}` : null;
  const parsed = parseFilter(view.draft, table.columns);
  const pending = !parsed.ok || JSON.stringify(parsed.filter) !== JSON.stringify(applied);
  const { conditions } = view.draft;

  return (
    <section
      aria-label={`Filter ${table.name}`}
      className="flex flex-col gap-1.5 border-b px-2 py-1.5 text-xs"
    >
      {conditions.length > 0 && (
        <ul aria-label="Conditions" className="flex flex-col gap-1">
          {conditions.map((c, i) => (
            <ConditionRow
              key={c.id}
              table={table}
              view={view}
              condition={c}
              index={i}
              scope={scope}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={() => addCondition(table)}>
          Add condition
        </Button>
        {conditions.length > 1 && (
          <span className="flex items-center gap-1">
            <span aria-hidden="true">Match</span>
            <NativeSelect
              aria-label="Match"
              value={view.draft.combinator}
              onChange={(e) =>
                setDraft(table.name, { ...view.draft, combinator: e.target.value as Combinator })
              }
            >
              <option value="and">all conditions (and)</option>
              <option value="or">any condition (or)</option>
            </NativeSelect>
          </span>
        )}
        <Button size="xs" disabled={!pending} onClick={() => applyDraft(table)}>
          Apply filter
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={conditions.length === 0 && !applied}
          onClick={() => clearFilter(table.name)}
        >
          Clear filter
        </Button>
        <span className="text-muted-foreground">
          {pending && conditions.length > 0
            ? "Not applied yet."
            : applied
              ? `Filter applied: ${applied.conditions.length} ${applied.conditions.length === 1 ? "condition" : "conditions"}.`
              : "No filter."}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          aria-expanded={showSql}
          aria-controls={`sql-${table.name}`}
          onClick={() => setShowSql(!showSql)}
        >
          SQL
        </Button>
      </div>
      {showSql && (
        <fieldset
          id={`sql-${table.name}`}
          aria-label="SQL WHERE clause"
          className="flex items-start gap-1.5"
        >
          <pre
            data-testid="filter-sql"
            className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-foreground"
          >
            {where ?? "No filter applied."}
          </pre>
          <Button
            size="xs"
            variant="outline"
            disabled={!where}
            onClick={() => {
              if (!where) return;
              navigator.clipboard.writeText(where).then(
                () => setCopied(true),
                () => setCopied(false),
              );
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy SQL"}
          </Button>
        </fieldset>
      )}
    </section>
  );
}
