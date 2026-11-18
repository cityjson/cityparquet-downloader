import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const LISTED_BY = {
  metadata: "files from metadata.json",
  probe: "files found by name",
  url: "a single file",
} as const;

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
          <AlertDescription>
            {pkg.url}: {pkg.message}
          </AlertDescription>
        </Alert>
      );
    case "ready": {
      const { info } = pkg;
      return (
        <Card className="gap-4 py-4">
          <CardHeader className="px-4">
            <CardTitle>
              <h2>Package</h2>
            </CardTitle>
            <CardDescription>
              <a href={pkg.url}>{pkg.url}</a>, {LISTED_BY[info.source.listedBy]}. Extent (WGS 84,
              lon/lat): <span data-testid="package-extent">{formatExtent(info.extentWgs84)}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <Table aria-label="Tables">
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead>CRS</TableHead>
                  <TableHead>LoDs</TableHead>
                  <TableHead className="text-right">Attributes</TableHead>
                  <TableHead className="text-right">Row groups</TableHead>
                  <TableHead>Extent (WGS 84)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {info.tables.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="font-medium text-foreground">{t.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(t.rowCount)}
                    </TableCell>
                    <TableCell>{formatCrs(t.crs)}</TableCell>
                    <TableCell>{t.lods.join(", ") || "none"}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.attributes.length}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(t.rowGroups.length)}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatExtent(t.extentWgs84)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      );
    }
  }
}
