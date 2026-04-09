/**
 * Lightweight Supabase REST client for the MCP server.
 * Uses raw fetch instead of @supabase/supabase-js to avoid
 * the broken realtime-js dependency in this workspace.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

if (!SUPABASE_URL) {
  console.error(
    "Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL.\n" +
    "Set this environment variable before starting the Kairos MCP server."
  );
}

if (!SUPABASE_KEY && !SUPABASE_ANON_KEY) {
  console.error(
    "Missing SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY.\n" +
    "Set at least one of these environment variables."
  );
}

// ── Session-level user token ─────────────────────────────────────────
// When set, queries use the user's token (RLS enforced) instead of
// the service role key (RLS bypassed). All existing tools automatically
// become user-scoped.
let _userToken: string | null = null;

/**
 * Set the user's access token for this session.
 * All subsequent queries will use this token, enforcing RLS.
 * Pass null to clear and revert to service role key.
 */
export function setUserToken(token: string | null) {
  _userToken = token;
}

/** Get the current user token (if set) */
export function getUserToken(): string | null {
  return _userToken;
}

function sbHeaders(): Record<string, string> {
  // User token takes priority (RLS enforced)
  // Falls back to service role key (RLS bypassed — development/admin only)
  // Falls back to anon key (RLS enforced, no user context)
  const authKey = _userToken || SUPABASE_KEY || SUPABASE_ANON_KEY;
  const apiKey = SUPABASE_KEY || SUPABASE_ANON_KEY;

  return {
    apikey: apiKey,
    Authorization: `Bearer ${authKey}`,
    "Content-Type": "application/json",
  };
}

interface QueryOptions {
  count?: boolean;
  single?: boolean;
  head?: boolean;
}

interface QueryResult<T = any> {
  data: T | null;
  error: { message: string; code: string } | null;
  count?: number;
}

/** Build a chainable query builder that mimics the Supabase JS API */
export function from(table: string) {
  return new QueryBuilder(table);
}

class QueryBuilder {
  private table: string;
  private filters: string[] = [];
  private selectFields = "*";
  private orderClause = "";
  private limitClause = "";
  private method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private body: any = null;
  private prefer: string[] = [];
  private isSingle = false;
  private isMaybeSingle = false;
  private isHead = false;
  private wantCount = false;

  constructor(table: string) {
    this.table = table;
  }

  select(fields = "*", opts?: { count?: "exact"; head?: boolean }) {
    this.selectFields = fields;
    this.method = "GET";
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.isHead = true;
    return this;
  }

  insert(data: any) {
    this.method = "POST";
    this.body = data;
    this.prefer.push("return=representation");
    return this;
  }

  update(data: any) {
    this.method = "PATCH";
    this.body = data;
    this.prefer.push("return=representation");
    return this;
  }

  delete() {
    this.method = "DELETE";
    return this;
  }

  eq(col: string, val: any) { this.filters.push(`${col}=eq.${val}`); return this; }
  neq(col: string, val: any) { this.filters.push(`${col}=neq.${val}`); return this; }
  gt(col: string, val: any) { this.filters.push(`${col}=gt.${val}`); return this; }
  gte(col: string, val: any) { this.filters.push(`${col}=gte.${val}`); return this; }
  lt(col: string, val: any) { this.filters.push(`${col}=lt.${val}`); return this; }
  lte(col: string, val: any) { this.filters.push(`${col}=lte.${val}`); return this; }
  ilike(col: string, val: string) { this.filters.push(`${col}=ilike.${encodeURIComponent(val)}`); return this; }
  in(col: string, vals: any[]) { this.filters.push(`${col}=in.(${vals.join(",")})`); return this; }
  or(expr: string) { this.filters.push(`or=(${expr})`); return this; }
  is(col: string, val: any) { this.filters.push(`${col}=is.${val}`); return this; }

  order(col: string, opts?: { ascending?: boolean }) {
    const dir = opts?.ascending === false ? "desc" : "asc";
    this.orderClause = `order=${col}.${dir}`;
    return this;
  }

  limit(n: number) {
    this.limitClause = `limit=${n}`;
    return this;
  }

  single(): Promise<QueryResult> {
    this.isSingle = true;
    this.prefer.push("return=representation");
    return this.execute();
  }

  maybeSingle(): Promise<QueryResult> {
    this.isMaybeSingle = true;
    return this.execute();
  }

  then(resolve: (val: QueryResult) => void, reject?: (err: any) => void) {
    return this.execute().then(resolve, reject);
  }

  private async execute(): Promise<QueryResult> {
    const params = [
      `select=${this.selectFields}`,
      ...this.filters,
      this.orderClause,
      this.limitClause,
    ].filter(Boolean).join("&");

    const url = `${SUPABASE_URL}/rest/v1/${this.table}?${params}`;
    const headers: Record<string, string> = { ...sbHeaders() };

    if (this.wantCount) this.prefer.push("count=exact");
    if (this.prefer.length > 0) headers["Prefer"] = this.prefer.join(", ");

    try {
      const res = await fetch(url, {
        method: this.isHead ? "HEAD" : this.method,
        headers,
        body: this.body ? JSON.stringify(this.body) : undefined,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText, code: String(res.status) }));
        return { data: null, error: { message: err.message, code: err.code || String(res.status) } };
      }

      let count: number | undefined;
      const contentRange = res.headers.get("content-range");
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)/);
        if (match) count = parseInt(match[1]);
      }

      if (this.isHead) {
        return { data: null, error: null, count };
      }

      const text = await res.text();
      if (!text) {
        return { data: this.isSingle ? null : [], error: null, count };
      }

      const data = JSON.parse(text);

      if (this.isSingle) {
        const row = Array.isArray(data) ? data[0] || null : data;
        return { data: row, error: null, count };
      }

      if (this.isMaybeSingle) {
        const row = Array.isArray(data) ? data[0] || null : data;
        return { data: row, error: null, count };
      }

      return { data, error: null, count };
    } catch (err) {
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : String(err), code: "FETCH_ERROR" },
      };
    }
  }
}

/** Call a Supabase RPC function */
export async function rpc(fn: string, params: Record<string, any> = {}): Promise<QueryResult> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      return { data: null, error: { message: err.message, code: String(res.status) } };
    }

    const data = await res.json().catch(() => null);
    return { data, error: null };
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : String(err), code: "FETCH_ERROR" },
    };
  }
}
