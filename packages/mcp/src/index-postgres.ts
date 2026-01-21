#!/usr/bin/env node

// --- MCP LOGGING FIX ---
// Redirect console.log to console.error to keep stdout clean for JSON-RPC
const originalLog = console.log;
console.log = (...args) => console.error(...args);
// -----------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "@mikeo-ai/claude-context-local-core";
import { PostgresVectorDatabase } from "@mikeo-ai/claude-context-local-core";

import { createMcpConfig, logConfigurationSummary, ContextMcpConfig } from "./config-postgres.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";

class ContextMcpServer {
    private server: Server;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;

    constructor(config: ContextMcpConfig) {
        this.server = new Server(
            {
                name: config.name,
                version: config.version
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Initialize embedding provider
        console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        // Initialize PostgreSQL vector database
        const vectorDatabase = new PostgresVectorDatabase({
            host: config.postgresHost,
            port: config.postgresPort,
            database: config.postgresDatabase,
            user: config.postgresUser,
            password: config.postgresPassword
        });

        // Initialize context with PostgreSQL
        this.context = new Context({
            embedding,
            vectorDatabase
        });

        // Initialize managers
        this.snapshotManager = new SnapshotManager();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager);

        // Load existing codebase snapshot on startup
        this.snapshotManager.loadCodebaseSnapshot();

        this.setupHandlers();
    }

    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "add_codebase",
                    description: "Add a codebase to the context for analysis",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                description: "Path to the codebase directory"
                            },
                            force: {
                                type: "boolean",
                                description: "Force re-indexing even if already indexed",
                                default: false
                            },
                            splitter: {
                                type: "string",
                                description: "Splitter type to use ('ast' or 'langchain')",
                                default: "ast"
                            },
                            customExtensions: {
                                type: "array",
                                items: { type: "string" },
                                description: "Additional file extensions to index"
                            },
                            ignorePatterns: {
                                type: "array",
                                items: { type: "string" },
                                description: "Additional ignore patterns"
                            }
                        },
                        required: ["path"]
                    }
                },
                {
                    name: "search_codebase",
                    description: "Search through indexed codebases",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Search query"
                            },
                            path: {
                                type: "string",
                                description: "Optional path to specific codebase directory. If not provided, searches all indexed codebases."
                            },
                            limit: {
                                type: "number",
                                description: "Maximum number of results"
                            },
                            extensionFilter: {
                                type: "array",
                                items: { type: "string" },
                                description: "Optional list of file extensions to filter results (e.g., ['.ts', '.py'])"
                            }
                        },
                        required: ["query"]
                    }
                },
                {
                    name: "reindex_codebase",
                    description: "Re-index an already indexed codebase",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                description: "Path to the codebase directory"
                            }
                        },
                        required: ["path"]
                    }
                }
            ]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            switch (name) {
                case "add_codebase":
                    return await this.toolHandlers.handleIndexCodebase({
                        ...args,
                        force: args?.force === true
                    });
                case "search_codebase":
                    return await this.toolHandlers.handleSearchCode({ ...args, path: args?.path || null });
                case "reindex_codebase":
                    return await this.toolHandlers.handleReindexCodebase(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async run(): Promise<void> {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.log(`[MCP] PostgreSQL Context MCP Server running`);
    }
}

async function main(): Promise<void> {
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.run();
}

main().catch(console.error);
