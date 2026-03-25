import { Client } from "@notionhq/client";
import type { NotionEnv } from "../config/env.js";

export interface NotionDayData {
  date: string;
  pages: Array<Record<string, unknown>>;
}

function isPageObjectResponse(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "object" in value &&
    (value as { object?: string }).object === "page"
  );
}

export class NotionDailyFetcher {
  private readonly client: Client;
  private readonly databaseId: string;
  private datePropertyName?: string;
  private dataSourceId?: string;

  constructor(env: NotionEnv) {
    this.client = new Client({ auth: env.NOTION_TOKEN });
    this.databaseId = env.NOTION_DATABASE_ID;
  }

  private async resolveDatePropertyName(): Promise<string> {
    if (this.datePropertyName) {
      return this.datePropertyName;
    }

    // Newer Notion API may expose schema via data sources.
    const db = (await this.client.databases.retrieve({
      database_id: this.databaseId
    })) as Record<string, unknown>;

    const dbProperties = db["properties"];
    if (dbProperties && typeof dbProperties === "object") {
      for (const [name, prop] of Object.entries(dbProperties as Record<string, Record<string, unknown>>)) {
        if (prop?.type === "date") {
          this.datePropertyName = name;
          return name;
        }
      }
    }

    const dataSources = db["data_sources"];
    if (Array.isArray(dataSources) && dataSources.length > 0) {
      const first = dataSources[0] as Record<string, unknown>;
      const id = first["id"];
      if (typeof id === "string" && id) {
        this.dataSourceId = id;
      }
    }

    if (!this.dataSourceId) {
      throw new Error(
        "Cannot resolve Notion schema. Check integration connection and Read content capability."
      );
    }

    const ds = (await (this.client as any).dataSources.retrieve({
      data_source_id: this.dataSourceId
    })) as Record<string, unknown>;

    const dsProperties = ds["properties"];
    if (dsProperties && typeof dsProperties === "object") {
      for (const [name, prop] of Object.entries(dsProperties as Record<string, Record<string, unknown>>)) {
        if (prop?.type === "date") {
          this.datePropertyName = name;
          return name;
        }
      }
    }

    throw new Error("No date property found in the Notion database/data source.");
  }

  async fetchByDate(ymd: string): Promise<NotionDayData> {
    const dateProp = await this.resolveDatePropertyName();

    if (this.dataSourceId) {
      const response = await (this.client as any).dataSources.query({
        data_source_id: this.dataSourceId,
        filter: {
          property: dateProp,
          date: {
            equals: ymd
          }
        },
        page_size: 100
      });
      const pages = ((response as { results?: unknown[] }).results ?? []).filter(isPageObjectResponse);
      return { date: ymd, pages };
    }

    const response = await (this.client.databases as any).query({
      database_id: this.databaseId,
      filter: {
        property: dateProp,
        date: {
          equals: ymd
        }
      },
      page_size: 100
    });

    const pages = response.results.filter(isPageObjectResponse);
    return { date: ymd, pages };
  }

  async fetchAll(): Promise<Array<Record<string, unknown>>> {
    // Ensure schema resolution first so dataSourceId can be discovered when needed.
    await this.resolveDatePropertyName();

    const pages: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;

    while (true) {
      if (this.dataSourceId) {
        const response = await (this.client as any).dataSources.query({
          data_source_id: this.dataSourceId,
          page_size: 100,
          start_cursor: cursor
        });

        const results = ((response as { results?: unknown[] }).results ?? []).filter(isPageObjectResponse);
        pages.push(...results);

        const hasMore = Boolean((response as { has_more?: boolean }).has_more);
        if (!hasMore) {
          break;
        }
        const next = (response as { next_cursor?: string | null }).next_cursor;
        cursor = typeof next === "string" ? next : undefined;
        continue;
      }

      const response = await (this.client.databases as any).query({
        database_id: this.databaseId,
        page_size: 100,
        start_cursor: cursor
      });

      const results = (response.results as unknown[]).filter(isPageObjectResponse);
      pages.push(...results);

      if (!response.has_more) {
        break;
      }
      cursor = response.next_cursor ?? undefined;
    }

    return pages;
  }
}
