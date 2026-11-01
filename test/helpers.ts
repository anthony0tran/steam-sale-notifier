export class MemoryKV {
  readonly store = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.store.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export function asKV(kv: MemoryKV): KVNamespace {
  return kv as unknown as KVNamespace;
}

export function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function searchRow(appId: string, name: string): string {
  return (
    `<a href="https://store.steampowered.com/app/${appId}/?snr=1_7_15__13" ` +
    `class="search_result_row ds_collapse_flag" data-ds-appid="${appId}" ` +
    `data-ds-itemkey="App_${appId}">` +
    `<div class="col search_name"><span class="title">${name}</span></div>` +
    `</a>`
  );
}

export function searchRows(games: ReadonlyArray<{ appId: string; name: string }>): string {
  return games.map((game) => searchRow(game.appId, game.name)).join("\n");
}
