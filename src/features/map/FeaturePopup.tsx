// The clicked feature's attributes, in a panel anchored to the map's corner.
import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { closePopup, usePopup } from "./popup";

export function FeaturePopup() {
  const popup = usePopup();
  const open = popup.state !== "closed" && popup.state !== "marked";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopup();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (popup.state === "closed" || popup.state === "marked") return null;
  const { feature } = popup;
  return (
    <section
      role="dialog"
      aria-label="Feature attributes"
      className="absolute top-3 right-3 z-10 flex max-h-[calc(100%-7rem)] w-[min(24rem,calc(100%-1.5rem))] flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-card"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-xs" title={feature.id}>
            {feature.id}
          </h2>
          <p className="text-xs text-muted-foreground">
            {feature.objectType} in {feature.table}, row {feature.row}
          </p>
        </div>
        <Button size="xs" variant="outline" onClick={closePopup}>
          Close
        </Button>
      </header>
      {popup.state === "loading" && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading attributes…
        </p>
      )}
      {popup.state === "failed" && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not read its attributes</AlertTitle>
          <AlertDescription className="break-all">{popup.message}</AlertDescription>
        </Alert>
      )}
      {popup.state === "ready" && (
        <div className="min-h-0 overflow-auto">
          <Table aria-label="Attributes" className="table-fixed text-xs">
            <TableBody>
              {popup.values.map(([key, value]) => (
                <TableRow key={key}>
                  <TableCell className="w-2/5 truncate py-1 pl-0 align-top font-medium" title={key}>
                    {key}
                  </TableCell>
                  <TableCell
                    className={`truncate py-1 pr-0 tabular-nums ${value === null ? "text-muted-foreground italic" : ""}`}
                    title={value ?? "null"}
                  >
                    {value ?? "null"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
