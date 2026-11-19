import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCount, formatCrs, formatExtent } from "./format";
import { usePackage } from "./store";

/** The open package, compact enough for the side panel; it folds away. */
export function PackageSummary() {
  const pkg = usePackage();
  switch (pkg.state) {
    case "idle":
      return null;
    case "opening":
      return <p role="status">Opening {pkg.url}…</p>;
    case "failed":
      return (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not open the package</AlertTitle>
          <AlertDescription className="break-all">
            {pkg.url}: {pkg.message}
          </AlertDescription>
        </Alert>
      );
    case "ready": {
      const { info } = pkg;
      const crs = [...new Set(info.tables.map((t) => formatCrs(t.crs)))];
      return (
        <details open className="group flex flex-col gap-2">
          <summary className="cursor-pointer list-inside marker:text-muted-foreground">
            <h2 className="inline">Package</h2>
          </summary>
          <div className="mt-2 flex flex-col gap-2 text-xs">
            <p className="break-all">
              <a href={pkg.url}>{pkg.url}</a>
            </p>
            <p>
              Extent (WGS 84 longitude, latitude):{" "}
              <span data-testid="package-extent" className="tabular-nums">
                {formatExtent(info.extentWgs84)}
              </span>
            </p>
            <p>CRS: {crs.join("; ")}</p>
            <Table aria-label="Tables" className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-7 px-1">Table</TableHead>
                  <TableHead className="h-7 px-1 text-right">Rows</TableHead>
                  <TableHead className="h-auto px-1 py-1 text-right whitespace-normal">
                    Row groups
                  </TableHead>
                  <TableHead className="h-7 px-1">LoDs</TableHead>
                  <TableHead className="h-7 px-1 text-right">Attributes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {info.tables.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="px-1 font-medium text-foreground">{t.name}</TableCell>
                    <TableCell className="px-1 text-right tabular-nums">
                      {formatCount(t.rowCount)}
                    </TableCell>
                    <TableCell className="px-1 text-right tabular-nums">
                      {formatCount(t.rowGroups.length)}
                    </TableCell>
                    <TableCell className="px-1 whitespace-normal">
                      {t.lods.join(", ") || "none"}
                    </TableCell>
                    <TableCell className="px-1 text-right tabular-nums">
                      {t.attributes.length}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
      );
    }
  }
}
