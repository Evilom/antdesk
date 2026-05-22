import { invoke } from "@tauri-apps/api/core";

const NOTION_VERSION = "2022-06-28";

const DB = {
  todos: "2d51ba51-3457-8125-9d4c-f28ffa2fff14",
  projects: "2d51ba51-3457-8127-840e-d8b43c0e5e21",
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
    sorts: [{ timestamp: "created_time", direction: "descending" }],
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
    status: page.properties.Status?.checkbox === true,
    priority: (page.properties.Priority?.select?.name || "Medium") as "High" | "Medium" | "Low",
    tags:
      page.properties.Tags?.multi_select?.map((t: any) => t.name) || [],
    projectId:
      page.properties.Project?.relation?.[0]?.id || undefined,
    dueDate: page.properties["Due Date"]?.date?.start || undefined,
    createdTime: page.created_time,
  }));
}

export async function createTodo(
  token: string,
  name: string,
  priority: "High" | "Medium" | "Low" = "Medium",
  projectId?: string,
  tags?: string[]
) {
  const properties: any = {
    Name: { title: [{ text: { content: name } }] },
    Priority: { select: { name: priority } },
    Status: { checkbox: false },
  };
  if (projectId) {
    properties.Project = { relation: [{ id: projectId }] };
  }
  if (tags && tags.length > 0) {
    properties.Tags = {
      multi_select: tags.map((t) => ({ name: t })),
    };
  }
  const body = JSON.stringify({
    parent: { database_id: DB.todos },
    properties,
  });
  const raw = await notionFetch("/v1/pages", "POST", body, token);
  const page = JSON.parse(raw);
  return {
    id: page.id,
    name,
    status: false,
    priority,
    tags: tags || [],
    projectId,
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
      Status: { checkbox: done },
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
      page.properties.Content?.rich_text?.[0]?.plain_text ||
      page.properties.Summary?.rich_text?.[0]?.plain_text || "",
    content: undefined,
  }));
}

export async function fetchReportContent(
  token: string,
  blockId: string
): Promise<string> {
  // Try reading page blocks (children) first
  const raw = await notionFetch(
    `/v1/blocks/${blockId}/children?page_size=100`,
    "GET",
    undefined,
    token
  );
  const data = JSON.parse(raw);
  const blockContent = data.results
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

  // If blocks are empty, fall back to Content property
  if (!blockContent.trim()) {
    const pageRaw = await notionFetch(
      `/v1/pages/${blockId}`,
      "GET",
      undefined,
      token
    );
    const page = JSON.parse(pageRaw);
    return (
      page.properties?.Content?.rich_text
        ?.map((t: any) => t.plain_text)
        .join("") ||
      page.properties?.Summary?.rich_text
        ?.map((t: any) => t.plain_text)
        .join("") ||
      "无内容"
    );
  }

  return blockContent;
}

export async function createReport(
  token: string,
  date: string,
  content: string
) {
  const lines = content.split("\n").filter(Boolean);
  const children = lines.map((line) => ({
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
  }));
  const body = JSON.stringify({
    parent: { database_id: DB.reports },
    properties: {
      Name: { title: [{ text: { content: `日报 ${date}` } }] },
      Date: { date: { start: date } },
      Content: { rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }] },
    },
    children,
  });
  const raw = await notionFetch("/v1/pages", "POST", body, token);
  const page = JSON.parse(raw);
  return {
    id: page.id,
    date,
    summary: lines[0]?.slice(0, 50) || "",
    content: undefined,
  };
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
    archived: page.archived === true,
  }));
}

export async function closeProject(token: string, projectId: string) {
  // Archive the project page in Notion
  await notionFetch(
    `/v1/pages/${projectId}`,
    "PATCH",
    JSON.stringify({ archived: true }),
    token
  );
}

export async function createProject(token: string, name: string) {
  const body = JSON.stringify({
    parent: { database_id: DB.projects },
    properties: {
      Name: { title: [{ text: { content: name } }] },
    },
  });
  const raw = await notionFetch("/v1/pages", "POST", body, token);
  const page = JSON.parse(raw);
  return {
    id: page.id,
    name,
    status: "",
  };
}
