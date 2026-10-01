import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

const APP_URI = "ui://eds/campaign-agent-v1.html";
const appHtml = readFileSync("public/eds-app.html", "utf8");
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 32000;

const fileInputSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

async function downloadUserFile(url) {
  if (!url.startsWith("https://")) {
    throw new Error("Only HTTPS file URLs are accepted.");
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Could not download brochure (HTTP ${response.status}).`);
  }

  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_FILE_BYTES) {
    throw new Error("Brochure is larger than the 20 MB app limit.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new Error("Brochure is larger than the 20 MB app limit.");
  }

  return buffer;
}

async function extractText(buffer, fileName = "", mimeType = "") {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();

  if (lowerMime.includes("pdf") || lowerName.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    return normalizeText(parsed.text);
  }

  if (
    lowerMime.includes("wordprocessingml") ||
    lowerName.endsWith(".docx")
  ) {
    const parsed = await mammoth.extractRawText({ buffer });
    return normalizeText(parsed.value);
  }

  if (
    lowerMime.startsWith("text/") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md")
  ) {
    return normalizeText(buffer.toString("utf8"));
  }

  throw new Error("Unsupported brochure type. Use PDF, DOCX, TXT, or MD.");
}

function createEdsServer() {
  const server = new McpServer(
    {
      name: "eds-campaign-agent",
      version: "1.0.0",
    },
    {
      instructions:
        "EDS Campaign Agent supports Blue Sky Travel B2B email campaigns. Preserve brochure facts exactly, never invent missing details, and use the concise approved EDS campaign structure.",
    }
  );

  registerAppResource(
    server,
    "eds-campaign-agent-ui",
    APP_URI,
    {},
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: appHtml,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            "openai/widgetDescription":
              "EDS Campaign Agent workspace for preparing Blue Sky Travel email blast campaigns from uploaded brochures.",
          },
        },
      ],
    })
  );

  registerAppTool(
    server,
    "open_eds_campaign_agent",
    {
      title: "Open EDS Campaign Agent",
      description:
        "Opens the EDS Campaign Agent workspace for creating a new Blue Sky Travel email blast campaign from a brochure.",
      inputSchema: {},
      outputSchema: {
        status: z.string(),
        supportedFiles: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        "openai/ui": {
          entrypoints: [{ type: "global" }],
        },
      },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "EDS Campaign Agent is ready. Upload a brochure and prepare a campaign brief.",
        },
      ],
      structuredContent: {
        status: "ready",
        supportedFiles: ["PDF", "DOCX", "TXT", "MD"],
      },
    })
  );

  registerAppTool(
    server,
    "extract_brochure",
    {
      title: "Extract EDS brochure",
      description:
        "Reads a user-provided travel brochure and returns its source text for an EDS email campaign. Use this before drafting when a brochure file is supplied.",
      inputSchema: {
        brochure: fileInputSchema,
        audience: z.string().max(300).optional(),
        specialBenefit: z.string().max(500).optional(),
        notes: z.string().max(1200).optional(),
      },
      outputSchema: {
        fileName: z.string(),
        mimeType: z.string(),
        extractedText: z.string(),
        truncated: z.boolean(),
        audience: z.string(),
        specialBenefit: z.string(),
        notes: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/fileParams": ["brochure"],
      },
    },
    async ({ brochure, audience, specialBenefit, notes }) => {
      try {
        const buffer = await downloadUserFile(brochure.download_url);
        const fullText = await extractText(
          buffer,
          brochure.file_name ?? "",
          brochure.mime_type ?? ""
        );

        const truncated = fullText.length > MAX_EXTRACTED_CHARS;
        const extractedText = fullText.slice(0, MAX_EXTRACTED_CHARS);

        return {
          content: [
            {
              type: "text",
              text: truncated
                ? "Brochure text extracted. The model-visible extract was trimmed to the first 32,000 characters."
                : "Brochure text extracted successfully.",
            },
          ],
          structuredContent: {
            fileName: brochure.file_name ?? "brochure",
            mimeType: brochure.mime_type ?? "",
            extractedText,
            truncated,
            audience: normalizeText(audience),
            specialBenefit: normalizeText(specialBenefit),
            notes: normalizeText(notes),
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not read brochure.";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    }
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          name: "EDS Campaign Agent MCP",
          status: "ok",
          endpoint: "/mcp",
          version: "1.0.0",
        })
      );
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createEdsServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`EDS Campaign Agent MCP listening on port ${port}`);
});
