/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The CityParquet package the app opens: a directory, a .parquet file or a wildcard. */
  readonly VITE_CITYPARQUET_URL?: string;
}
