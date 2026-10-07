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
  isolate_workspace: { name: 'isolate_workspace', description: 'Work in your own git worktree from your next turn, so your edits can\'t collide with other agents\'. Your changes reach the user\'s folder only after review. Available in Full access.', inputSchema: object({}, []) }
};
export const ROOM_TOOL_NAMES = Object.keys(roomToolSpecs) as RoomToolName[];
