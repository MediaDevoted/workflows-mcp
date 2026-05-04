import pg from "pg";
import { EmbeddingsClient } from "./embeddings.js";

const { Pool } = pg;

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS workflow_embeddings (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  triggers TEXT[],
  connectors TEXT[],
  assigned_roles TEXT[],
  updated_at TIMESTAMPTZ NOT NULL,
  discovery_embedding VECTOR(1536),
  body_embedding VECTOR(1536),
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_embeddings_discovery ON workflow_embeddings USING hnsw (discovery_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_workflow_embeddings_body ON workflow_embeddings USING hnsw (body_embedding vector_cosine_ops);
`;

export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

export type SearchMode = "fast" | "deep";

export interface SearchHit {
  slug: string;
  title: string;
  description: string;
  score: number;
  matched_via: "discovery" | "body";
}

export interface UpsertRow {
  slug: string;
  title: string;
  description: string;
  triggers: string[];
  connectors: string[];
  assignedRoles: string[];
  updatedAt: string;
  discoveryEmbedding: number[];
  bodyEmbedding: number[];
}

export interface ExistingRow {
  slug: string;
  updatedAt: string;
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export class EmbeddingsStore {
  private pool: pg.Pool | null = null;
  private initialized = false;

  constructor(private readonly connectionString: string) {}

  private getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
      this.pool.on("error", () => {
        // Surfacing the specific error here would be redundant with per-query errors.
      });
    }
    return this.pool;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.getPool().query(SCHEMA_SQL);
      this.initialized = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new StoreUnavailableError(`pgvector schema init failed: ${msg}`);
    }
  }

  async listExisting(): Promise<ExistingRow[]> {
    await this.init();
    try {
      const result = await this.getPool().query<{ slug: string; updated_at: Date }>(
        "SELECT slug, updated_at FROM workflow_embeddings",
      );
      return result.rows.map((r) => ({ slug: r.slug, updatedAt: r.updated_at.toISOString() }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new StoreUnavailableError(`pgvector listExisting failed: ${msg}`);
    }
  }

  async upsert(rows: UpsertRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.init();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        await client.query(
          `INSERT INTO workflow_embeddings
             (slug, title, description, triggers, connectors, assigned_roles, updated_at, discovery_embedding, body_embedding, embedded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::vector, NOW())
           ON CONFLICT (slug) DO UPDATE SET
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             triggers = EXCLUDED.triggers,
             connectors = EXCLUDED.connectors,
             assigned_roles = EXCLUDED.assigned_roles,
             updated_at = EXCLUDED.updated_at,
             discovery_embedding = EXCLUDED.discovery_embedding,
             body_embedding = EXCLUDED.body_embedding,
             embedded_at = NOW()`,
          [
            row.slug,
            row.title,
            row.description,
            row.triggers,
            row.connectors,
            row.assignedRoles,
            row.updatedAt,
            vectorLiteral(row.discoveryEmbedding),
            vectorLiteral(row.bodyEmbedding),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const msg = error instanceof Error ? error.message : String(error);
      throw new StoreUnavailableError(`pgvector upsert failed: ${msg}`);
    } finally {
      client.release();
    }
  }

  async deleteSlugs(slugs: string[]): Promise<number> {
    if (slugs.length === 0) return 0;
    await this.init();
    try {
      const result = await this.getPool().query(
        "DELETE FROM workflow_embeddings WHERE slug = ANY($1::text[])",
        [slugs],
      );
      return result.rowCount ?? 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new StoreUnavailableError(`pgvector delete failed: ${msg}`);
    }
  }

  async query(opts: {
    embedding: number[];
    visibleSlugs: string[];
    limit: number;
    mode: SearchMode;
  }): Promise<SearchHit[]> {
    if (opts.visibleSlugs.length === 0) return [];
    await this.init();
    const vec = vectorLiteral(opts.embedding);
    const sql = `
      SELECT slug, title, description,
             1 - (discovery_embedding <=> $1::vector) AS discovery_score,
             1 - (body_embedding <=> $1::vector) AS body_score
      FROM workflow_embeddings
      WHERE slug = ANY($2::text[])
      ORDER BY (CASE WHEN $3 = 'deep'
                     THEN (discovery_embedding <=> $1::vector) * 0.6 + (body_embedding <=> $1::vector) * 0.4
                     ELSE (discovery_embedding <=> $1::vector) END) ASC
      LIMIT $4
    `;
    try {
      const result = await this.getPool().query<{
        slug: string;
        title: string;
        description: string | null;
        discovery_score: string | number;
        body_score: string | number;
      }>(sql, [vec, opts.visibleSlugs, opts.mode, opts.limit]);
      return result.rows.map((row) => {
        const discovery = Number(row.discovery_score);
        const body = Number(row.body_score);
        const score = opts.mode === "deep" ? discovery * 0.6 + body * 0.4 : discovery;
        const matched_via: "discovery" | "body" = body > discovery ? "body" : "discovery";
        return {
          slug: row.slug,
          title: row.title,
          description: row.description ?? "",
          score,
          matched_via,
        };
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new StoreUnavailableError(`pgvector query failed: ${msg}`);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
      this.pool = null;
      this.initialized = false;
    }
  }
}

export const embeddingDimensions = EmbeddingsClient.dimensions;
