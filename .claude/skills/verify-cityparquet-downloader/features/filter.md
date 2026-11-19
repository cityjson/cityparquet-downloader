# Filter

Each table's tab in the drawer has a filter bar. `Add condition` adds a row: a column
chosen from a searchable list (each with its type icon), an operator its type allows and
a value; a text column with at most 20 values in scope offers them. Two or more
conditions are joined by `Match`: all (and) or any (or). The draft is applied with
`Apply filter` and removed with `Clear filter`; until applied, the bar says `Not applied
yet.` The `SQL` button shows the applied filter as a `WHERE` clause, with `Copy SQL`. The
filter narrows that table's selection, its map highlight and its grid.

## Sub-features

- `filter-column` picks a column from a searchable list.
- `filter-operator` offers the operators of the column's type: text (equals, does not equal, contains, starts with, ends with, is one of, is null, is not null), number and date (=, ≠, <, ≤, >, ≥, between, null checks), boolean.
- `filter-values` offers a text column's values when there are at most 20 in scope.
- `filter-combinator` joins conditions by and or or.
- `filter-apply` applies the draft; `filter-clear` removes the filter.
- `filter-errors` shows a bad value under its row (role `alert`) and applies nothing.
- `filter-sql` shows and copies the `WHERE` clause.

## How to get to it (user POV)

- Open the drawer's tab for the table (`Show table` if it is hidden). Click `Add condition`, pick the column, the operator and the value, then `Apply filter`.

## Driving it with control

Preconditions:

- The table's selection is counted: `control browser text --testid selection-<table>` reads `N of M features selected, …`.

- **Add.** `control browser click --role button --name "Add condition"`; `control browser click --role button --name "Column of condition 1"`; `control browser fill --role textbox --name "Search columns" --value oorspronkelijkbouwjaar`; `control browser press --key Enter`.
- **Operator and value.** `control browser select --role combobox --name "Operator of condition 1" --value lt`; `control browser fill --label "Value of condition 1" --value 1950`.
- **Apply.** `control browser click --role button --name "Apply filter"`. The bar reads `Filter applied: 1 condition.`; with the Delft area drawn ([extent-selection.md](./extent-selection.md)), `selection-building` reads `123 of …` on the fixture, and one or two fewer on 3DBAG when its area holds 197.
- **Or.** Add a second condition `b3_pw_bron` `contains` `hn4`, then `control browser select --role combobox --name Match --value or` and apply: `124 of …`.
- **SQL.** `control browser click --role button --name SQL`; `control browser text --testid filter-sql` prints `WHERE ("oorspronkelijkbouwjaar" < 1950) OR ("b3_pw_bron" ILIKE '%hn4%' ESCAPE '\')`.
- **Values.** Click into `Value of condition N` of a `b3_dak_type` condition: `control browser eval --js "[...document.querySelectorAll('datalist option')].map(o => o.value)"` lists `slanted`, `horizontal`, `multiple horizontal`, `unknown` on Delft.
- **Error.** A number column with value `abc`, then `Apply filter`: `control browser text --role alert` prints the message.
- **Clear.** `control browser click --role button --name "Clear filter"`: `No filter.`, and the count returns.
- **Proof.** The counts against native DuckDB: `scripts/expect-selection.py`, and screenshot `filter/<source>/applied.png` with the highlight.

## Gotchas

- A value box that offers values has the role `combobox`, not `textbox`: target it with `--label`.
- `≠` keeps rows where the column is null; `<` and the others do not.
- `contains`, `starts with` and `ends with` ignore case.
- On 3DBAG, applying a filter on a column not read yet takes a second or two per row group in scope; the scope line says `Reading the filter's columns in …` meanwhile.
