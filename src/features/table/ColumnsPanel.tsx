// Which columns the grid shows. The order stays the table's: reserved columns, then
// attributes. Only the columns shown are read.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { kindOf, type PackageTable } from "@/core";
import { ColumnTypeIcon } from "./ColumnTypeIcon";
import { setShown, shownColumns, type TableView, tableColumns } from "./store";

export function ColumnsPanel({ table, view }: { table: PackageTable; view: TableView }) {
  const [query, setQuery] = useState("");
  const columns = tableColumns(table);
  const shown = new Set(shownColumns(table, view));
  const matches = columns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const toggle = (name: string) => {
    const next = new Set(shown);
    if (!next.delete(name)) next.add(name);
    setShown(
      table.name,
      columns.map((c) => c.name).filter((c) => next.has(c)),
    );
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" aria-label="Columns">
          Columns {shown.size} of {columns.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-2">
        <Input
          aria-label="Search columns"
          placeholder="Search columns"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              setShown(
                table.name,
                columns.map((c) => c.name),
              )
            }
          >
            Show all
          </Button>
          <Button size="xs" variant="outline" onClick={() => setShown(table.name, null)}>
            Default columns
          </Button>
        </div>
        <ul aria-label="Columns to show" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {matches.map((c) => (
            <li key={c.name}>
              <div className="flex items-center gap-1.5 rounded px-1 py-0.5 text-foreground hover:bg-muted">
                <Checkbox
                  aria-label={`Show ${c.name}`}
                  checked={shown.has(c.name)}
                  onCheckedChange={() => toggle(c.name)}
                />
                <ColumnTypeIcon kind={kindOf(c.type)} type={c.type} />
                <button type="button" className="truncate text-left" onClick={() => toggle(c.name)}>
                  {c.name}
                </button>
              </div>
            </li>
          ))}
          {matches.length === 0 && <li className="p-1">No column matches.</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
