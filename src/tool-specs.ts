import { RoomToolDefinition, RoomToolName, ToolName } from './types';
export const toolSpecs: Record<ToolName, { name: ToolName; description: string; inputSchema: object }> = {
  list_files: { name: 'list_files', description: 'List real workspace files. Always use before making claims about repository contents.', inputSchema: { type: 'object', properties: { glob: { type: 'string', description: 'Glob relative to workspace, for example **/*' } }, additionalProperties: false } },
  read_file: { name: 'read_file', description: 'Read an existing workspace file to ground an answer in actual source code. PDF, Word (.docx) and image files are converted to text automatically, using local OCR for scans and images.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  search_files: { name: 'search_files', description: 'Search workspace files for literal text.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  search_documents: { name: 'search_documents', description: 'Search the documents attached to this Chatroom (PDFs, Word files, images, text) by meaning and return the most relevant passages with page numbers.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  ollama_ocr: { name: 'ollama_ocr', description: 'Extract text from a workspace image using the selected local OCR model.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  semantic_search: { name: 'semantic_search', description: 'Find relevant code snippets using the selected local embedding model.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' } }, required: ['query'], additionalProperties: false } }
};
const object = (properties: Record<string, object>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
/** Room tools offered to every native CLI (Claude via in-process MCP, Codex via dynamic tools, Copilot via HTTP MCP). Order is stable. */
export const roomToolSpecs: Record<RoomToolName, RoomToolDefinition> = {
  search_documents: { name: 'search_documents', description: 'Search the documents attached to this Chatroom (PDFs, Word files, images, text) by meaning and return the most relevant passages with page numbers.', inputSchema: object({ query: { type: 'string' } }, ['query']) },
  read_document: { name: 'read_document', description: 'Read a PDF, Word (.docx) or image file from the workspace as text, using local OCR for scans and images. It also attaches the file to the room so every agent can search it. Use your own tools for plain text files.', inputSchema: object({ path: { type: 'string', description: 'Workspace-relative path' } }, ['path']) },
  semantic_search: { name: 'semantic_search', description: 'Find relevant workspace code or text snippets with the local embedding model.', inputSchema: object({ query: { type: 'string' }, glob: { type: 'string' } }, ['query']) },
  ollama_ocr: { name: 'ollama_ocr', description: 'Extract text from a workspace image with the local vision model.', inputSchema: object({ path: { type: 'string' } }, ['path']) },
  isolate_workspace: { name: 'isolate_workspace', description: 'Work in your own git worktree from your next turn, so your edits can\'t collide with other agents\'. Your changes reach the user\'s folder only after review. Available in Full access.', inputSchema: object({}, []) },
  sandbox_run: { name: 'sandbox_run', description: 'Run a shell command or a script in a throwaway Docker container on a copy of your folder, after the user approves it on a card. Use it to run tests, try code or check risky code without touching the real files. There is no network unless you ask for it and the user approves, and CPU, memory, process and time limits apply. You get the exit code, the output tails and the files the run created or changed; the room sees the result too.',
    inputSchema: object({
      command: { type: 'string', description: 'A shell command, run with sh -lc in /work (the copy of your folder). Give command or code.' },
      code: { type: 'string', description: 'A script to run instead of a command; set language.' },
      language: { type: 'string', enum: ['bash', 'python', 'node'], description: 'The script\'s language. It also picks the image: bash = Debian slim, python = Python 3.12, node = Node.js 22 (default bash).' },
      profile: { type: 'string', enum: ['test', 'security'], description: 'test (default): a writable copy. security: a non-root user and a read-only copy, for code you don\'t trust.' },
      network: { type: 'boolean', description: 'Ask for network access inside the container (default false). Only when the run needs it, for example to install packages.' },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Time limit; the container is killed after it (default: the user\'s setting, 120 s).' },
      outputs: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Globs (relative to /work) of files whose text you want back, for example ["report.txt", "out/*.json"]. Files under 64 KB.' },
      purpose: { type: 'string', description: 'One line telling the user why this run is needed.' },
      copyFiles: { type: 'boolean', description: 'false runs in an empty /work, for code that needs no files (faster). Default true.' }
    }, []) }
};
export const ROOM_TOOL_NAMES = Object.keys(roomToolSpecs) as RoomToolName[];
