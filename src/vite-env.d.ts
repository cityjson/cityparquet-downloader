/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The CityParquet package the app opens: a directory, a .parquet file or a wildcard. */
  readonly VITE_CITYPARQUET_URL?: string;
  /** A CARTO Basemaps API key. With one the basemap is CARTO's raster tiles. */
  readonly VITE_CARTO_KEY?: string;
  /** "1": the engine's wasm comes from jsDelivr instead of the build (the deploy build). */
  readonly VITE_DUCKDB_CDN?: string;
}

/** The installed `@duckdb/duckdb-wasm` version, set by vite.config.ts. */
declare const __DUCKDB_WASM_VERSION__: string;
