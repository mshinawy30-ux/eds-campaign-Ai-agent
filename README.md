# EDS Campaign AI Agent

MCP + sidebar app companion for the private **EDS Campaign Agent** ChatGPT plugin.

## What it does
- Adds a global ChatGPT sidebar entry through OpenAI MCP Extensions.
- Opens a fullscreen EDS campaign workspace.
- Lets the user upload/select a brochure, add audience/client notes, discount wording, and campaign notes.
- Extracts text from PDF, DOCX, or TXT brochures on the MCP server.
- Sends a structured follow-up into ChatGPT so the existing EDS campaign workflow can generate:
  1. Offer Name
  2. Email Subject
  3. Email Body
  4. Source Check only when needed

## Endpoint
The server exposes Streamable HTTP MCP at:

`/mcp`

Health check:

`/`

## Local run
```bash
npm install
npm start
```

Then connect MCP Inspector or ChatGPT Developer Mode to `http://localhost:8787/mcp`.

## Notes
This repo contains no OpenAI API key and does not call the OpenAI API directly. The ChatGPT host remains responsible for the language-model step.
