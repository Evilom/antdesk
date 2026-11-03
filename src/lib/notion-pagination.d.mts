export interface NotionPageResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor?: string | null;
}
export function collectNotionPages<T>(fetchPage: (cursor?: string) => Promise<NotionPageResponse<T>>): Promise<T[]>;
