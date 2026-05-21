import { invoke } from "@tauri-apps/api/core";

const NOTION_VERSION = "2022-06-28";

const DB = {
  todos: "2d51ba51-3457-815e-8850-000b6ebaa003",
  projects: "2d51ba51-3457-813a-9eeb-000b6715eed1",
  reports: "2d51ba51-3457-8158-84e1-c5cbc66ed8b2",
};

async function notionFetch(
  path: string,
  method: string = "GET",
  body?: string,
  token?: string
): Promise<string> {
  return invoke<string>("fetch_notion", { path, method, body, token });
}

export async function getNotionToken(): Promise<string> {
  return invoke<string>("get_notion_token");
}

// ---- Todos ----

export async function fetchTodos(token: string) {
  const body = JSON.stringify({
    sorts: [{ property: "Created time", direction: "descending" }],
    page_size: 100,
  });
  const raw = await notionFetch(
    `/v1/databases/${DB.todos}/query`,
    "POST",
    body,
    token
  );
  const data = JSON.parse(raw);
  return data.results.map((page: any) => ({
    id: page.id,
    name: page.properties.Name?.title?.[0]?.plain_text || "",
    status: page.properties.Status?.status?.name === "Done",
    priority: (page.properties.Priority?.select?.name || "Medium") as "High" | "Medium" | "Low",
    tags:
      page.properties.Tags?.multi_select?.map((t: any) => t.name) || [],
    projectId:
      page.properties.Project?.relation?.[0]?.id || undefined,
    createdTime: page.created_time,
  }));
}

export async function createTodo(
  token: string,
  name: string,
  priority: "High" | "Medium" | "Low" = "Medium"
) {
  const body = JSON.stringify({
    parent: { database_id: DB.todos },
    properties: {
      Name: { title: [{ text: { content: name } }] },
      Priority: { select: { name: priority } },
      Status: { status: { name: "To Do" } },
    },
  });
  const raw = await notionFetch("/v1/pages", "POST", body, token);
  const page = JSON.parse(raw);
  return {
    id: page.id,
    name,
    status: false,
    priority,
    tags: [],
    createdTime: page.created_time,
  };
}

export async function toggleTodoStatus(
  token: string,
  id: string,
  done: boolean
) {
  const body = JSON.stringify({
    properties: {
      Status: { status: { name: done ? "Done" : "To Do" } },
    },
  });
  await notionFetch(`/v1/pages/${id}`, "PATCH", body, token);
}

// ---- Reports ----

export async function fetchReports(token: string) {
  const body = JSON.stringify({
    sorts: [{ property: "Date", direction: "descending" }],
    page_size: 10,
  });
  const raw = await notionFetch(
    `/v1/databases/${DB.reports}/query`,
    "POST",
    body,
    token
  );
  const data = JSON.parse(raw);
  return data.results.map((page: any) => ({
    id: page.id,
    date:
      page.properties.Date?.date?.start || page.created_time?.slice(0, 10),
    summary:
      page.properties.Summary?.rich_text?.[0]?.plain_text || "",
    content: undefined,
  }));
}

export async function fetchReportContent(
  token: string,
  blockId: string
): Promise<string> {
  const raw = await notionFetch(
    `/v1/blocks/${blockId}/children?page_size=100`,
    "GET",
    undefined,
    token
  );
  const data = JSON.parse(raw);
  return data.results
    .map((block: any) => {
      if (block.type === "paragraph") {
        return block.paragraph.rich_text
          .map((t: any) => t.plain_text)
          .join("");
      }
      if (block.type === "heading_1") {
        return "# " + block.heading_1.rich_text.map((t: any) => t.plain_text).join("");
      }
      if (block.type === "heading_2") {
        return "## " + block.heading_2.rich_text.map((t: any) => t.plain_text).join("");
      }
      if (block.type === "heading_3") {
        return "### " + block.heading_3.rich_text.map((t: any) => t.plain_text).join("");
      }
      if (block.type === "bulleted_list_item") {
        return "- " + block.bulleted_list_item.rich_text.map((t: any) => t.plain_text).join("");
      }
      if (block.type === "numbered_list_item") {
        return "1. " + block.numbered_list_item.rich_text.map((t: any) => t.plain_text).join("");
      }
      if (block.type === "to_do") {
        const checked = block.to_do.checked ? "[x]" : "[ ]";
        return `${checked} ${block.to_do.rich_text.map((t: any) => t.plain_text).join("")}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ---- Projects ----

export async function fetchProjects(token: string) {
  const body = JSON.stringify({ page_size: 50 });
  const raw = await notionFetch(
    `/v1/databases/${DB.projects}/query`,
    "POST",
    body,
    token
  );
  const data = JSON.parse(raw);
  return data.results.map((page: any) => ({
    id: page.id,
    name: page.properties.Name?.title?.[0]?.plain_text || "",
    status: page.properties.Status?.status?.name || "",
  }));
}
