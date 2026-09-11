import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

/**
 * One table, four states: loading, error, empty, rows. The old app grew 200-line pages largely
 * because every page re-implemented those four; here a page declares its columns and hands over
 * the query result.
 *
 * `numeric` columns get the `numeric` class, which styles.css maps to right-aligned tabular
 * numerals — money and quantities line up digit for digit down the column.
 */
export interface Column<T> {
  key: string;
  header: string;
  numeric?: boolean;
  className?: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  isLoading = false,
  error,
  empty,
  onRowClick,
  isRowActive,
}: {
  columns: Column<T>[];
  data: T[] | undefined;
  rowKey: (row: T) => string;
  isLoading?: boolean;
  error?: { message?: string } | null;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  isRowActive?: (row: T) => boolean;
}) {
  if (error) {
    return (
      <div className="px-6 py-10 text-center text-[13px] text-destructive">
        {error.message ?? "Something went wrong loading this list."}
      </div>
    );
  }

  if (isLoading) {
    return (
      <Table>
        <TableHeader>
          <tr>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.numeric ? "text-right" : undefined}>
                {column.header}
              </TableHead>
            ))}
          </tr>
        </TableHeader>
        <TableBody>
          {[0, 1, 2].map((row) => (
            <TableRow key={row}>
              {columns.map((column) => (
                <TableCell key={column.key}>
                  <span className="block h-3 w-24 animate-pulse rounded bg-border" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (!data || data.length === 0) return <>{empty}</>;

  return (
    <Table>
      <TableHeader>
        <tr>
          {columns.map((column) => (
            <TableHead key={column.key} className={column.numeric ? "text-right" : undefined}>
              {column.header}
            </TableHead>
          ))}
        </tr>
      </TableHeader>
      <TableBody>
        {data.map((row) => (
          <TableRow
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={[
              onRowClick ? "cursor-pointer" : "",
              isRowActive?.(row) ? "bg-accent! hover:bg-accent!" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {columns.map((column) => (
              <TableCell key={column.key} className={[column.numeric ? "numeric" : "", column.className ?? ""].join(" ")}>
                {column.render(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
