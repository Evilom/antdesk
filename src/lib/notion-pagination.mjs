// A failed later page rejects the whole read so callers can keep the last complete cache.
export async function collectNotionPages(fetchPage) {
  const pages = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor;
  for (let count = 0; count < 2000; count++) {
    const response = await fetchPage(cursor);
    if (!response || !Array.isArray(response.results) || typeof response.has_more !== 'boolean') {
      throw new Error('Notion 返回了无效的分页数据，已保留原缓存。');
    }
    for (const page of response.results) {
      if (typeof page?.id === 'string') {
        if (ids.has(page.id)) continue;
        ids.add(page.id);
      }
      pages.push(page);
    }
    if (!response.has_more) return pages;
    const next = response.next_cursor;
    if (typeof next !== 'string' || !next || cursors.has(next)) {
      throw new Error('Notion 分页游标重复或缺失，已保留原缓存。');
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error('Notion 分页数量超出安全范围，已保留原缓存。');
}
