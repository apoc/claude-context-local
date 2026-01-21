import Parser from 'tree-sitter';
import { Splitter, CodeChunk } from './index';

// Safe loader for tree-sitter parsers
function safeRequire(moduleName: string): any {
    try {
        const mod = require(moduleName);
        // Special case for tree-sitter-typescript which has sub-modules
        if (moduleName.includes('typescript') && mod.typescript) {
            return mod.typescript;
        }
        return mod;
    } catch (error: any) {
        console.warn(`[ASTSplitter] ⚠️  Failed to load ${moduleName}. AST splitting for this language will be disabled:`, error.message);
        return null;
    }
}

const JavaScript = safeRequire('tree-sitter-javascript');
const TypeScript = safeRequire('tree-sitter-typescript');
const Python = safeRequire('tree-sitter-python');
const Java = safeRequire('tree-sitter-java');
const Cpp = safeRequire('tree-sitter-cpp');
const Go = safeRequire('tree-sitter-go');
const Rust = safeRequire('tree-sitter-rust');
const CSharp = safeRequire('tree-sitter-c-sharp');
const Scala = safeRequire('tree-sitter-scala');
const Dart = safeRequire('tree-sitter-dart');

// Node types that represent logical code units
const SPLITTABLE_NODE_TYPES = {
    javascript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition', 'export_statement'],
    typescript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition', 'export_statement', 'interface_declaration', 'type_alias_declaration'],
    python: ['function_definition', 'class_definition', 'decorated_definition', 'async_function_definition', 'module', 'expression_statement'],
    java: ['method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration', 'annotation_type_declaration'],
    cpp: ['function_definition', 'class_specifier', 'namespace_definition', 'declaration', 'template_declaration'],
    go: ['function_declaration', 'method_declaration', 'type_declaration', 'var_declaration', 'const_declaration', 'source_file'],
    rust: ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item', 'macro_definition', 'source_file'],
    csharp: ['method_declaration', 'class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration', 'delegate_declaration'],
    scala: ['method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration', 'object_definition', 'trait_definition'],
    dart: ['class_definition', 'enum_declaration', 'mixin_declaration', 'extension_declaration', 'method_signature', 'function_signature', 'getter_signature', 'setter_signature', 'constructor_signature']
};

export class AstCodeSplitter implements Splitter {
    private chunkSize: number = 2500;
    private chunkOverlap: number = 300;
    private parser: Parser;
    private langchainFallback: any; // LangChainCodeSplitter for fallback

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize) this.chunkSize = chunkSize;
        if (chunkOverlap) this.chunkOverlap = chunkOverlap;
        this.parser = new Parser();

        // Initialize fallback splitter
        const { LangChainCodeSplitter } = require('./langchain-splitter');
        this.langchainFallback = new LangChainCodeSplitter(chunkSize, chunkOverlap);
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        // Check if language is supported by AST splitter
        const langConfig = this.getLanguageConfig(language);
        if (!langConfig) {
            console.log(`📝 Language ${language} not supported by AST, using LangChain splitter for: ${filePath || 'unknown'}`);
            return await this.langchainFallback.split(code, language, filePath);
        }

        try {
            console.log(`🌳 Using AST splitter for ${language} file: ${filePath || 'unknown'}`);

            this.parser.setLanguage(langConfig.parser);
            const tree = this.parser.parse(code);

            if (!tree.rootNode) {
                console.warn(`[ASTSplitter] ⚠️  Failed to parse AST for ${language}, falling back to LangChain: ${filePath || 'unknown'}`);
                return await this.langchainFallback.split(code, language, filePath);
            }

            // Extract chunks based on AST nodes
            const chunks = this.extractChunks(tree.rootNode, code, langConfig.nodeTypes, language, filePath);

            // If chunks are too large, split them further
            const refinedChunks = await this.refineChunks(chunks, code);

            return refinedChunks;
        } catch (error) {
            console.warn(`[ASTSplitter] ⚠️  AST splitter failed for ${language}, falling back to LangChain: ${error}`);
            return await this.langchainFallback.split(code, language, filePath);
        }
    }

    setChunkSize(chunkSize: number): void {
        this.chunkSize = chunkSize;
        this.langchainFallback.setChunkSize(chunkSize);
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.chunkOverlap = chunkOverlap;
        this.langchainFallback.setChunkOverlap(chunkOverlap);
    }

    private getLanguageConfig(language: string): { parser: any; nodeTypes: string[] } | null {
        const langMap: Record<string, { parser: any; nodeTypes: string[] }> = {
            'javascript': { parser: JavaScript, nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'js': { parser: JavaScript, nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'typescript': { parser: TypeScript, nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'ts': { parser: TypeScript, nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'python': { parser: Python, nodeTypes: SPLITTABLE_NODE_TYPES.python },
            'py': { parser: Python, nodeTypes: SPLITTABLE_NODE_TYPES.python },
            'java': { parser: Java, nodeTypes: SPLITTABLE_NODE_TYPES.java },
            'cpp': { parser: Cpp, nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'c++': { parser: Cpp, nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'c': { parser: Cpp, nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'go': { parser: Go, nodeTypes: SPLITTABLE_NODE_TYPES.go },
            'rust': { parser: Rust, nodeTypes: SPLITTABLE_NODE_TYPES.rust },
            'rs': { parser: Rust, nodeTypes: SPLITTABLE_NODE_TYPES.rust },
            'cs': { parser: CSharp, nodeTypes: SPLITTABLE_NODE_TYPES.csharp },
            'csharp': { parser: CSharp, nodeTypes: SPLITTABLE_NODE_TYPES.csharp },
            'scala': { parser: Scala, nodeTypes: SPLITTABLE_NODE_TYPES.scala },
            'dart': { parser: Dart, nodeTypes: SPLITTABLE_NODE_TYPES.dart }
        };

        return langMap[language.toLowerCase()] || null;
    }

    private extractChunks(
        node: Parser.SyntaxNode,
        code: string,
        splittableTypes: string[],
        language: string,
        filePath?: string
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const codeLines = code.split('\n');

        const traverse = (currentNode: Parser.SyntaxNode) => {
            // Check if this node type should be split into a chunk
            if (splittableTypes.includes(currentNode.type)) {
                const startLine = currentNode.startPosition.row + 1;
                const endLine = currentNode.endPosition.row + 1;
                const nodeText = code.slice(currentNode.startIndex, currentNode.endIndex);

                // Only create chunk if it has meaningful content
                if (nodeText.trim().length > 0) {
                    // Check if this node is likely a definition/declaration
                    const isDefinition = this.isDefinitionNode(currentNode.type, language);

                    chunks.push({
                        content: nodeText,
                        metadata: {
                            startLine,
                            endLine,
                            language,
                            filePath,
                            isDefinition
                        }
                    });
                }
            }

            // Continue traversing child nodes
            for (const child of currentNode.children) {
                traverse(child);
            }
        };

        traverse(node);

        // If no meaningful chunks found, create a single chunk with the entire code
        if (chunks.length === 0) {
            chunks.push({
                content: code,
                metadata: {
                    startLine: 1,
                    endLine: codeLines.length,
                    language,
                    filePath,
                }
            });
        }

        return chunks;
    }

    private async refineChunks(chunks: CodeChunk[], originalCode: string): Promise<CodeChunk[]> {
        const refinedChunks: CodeChunk[] = [];

        for (const chunk of chunks) {
            if (chunk.content.length <= this.chunkSize) {
                refinedChunks.push(chunk);
            } else {
                // Split large chunks using character-based splitting
                const subChunks = this.splitLargeChunk(chunk, originalCode);
                refinedChunks.push(...subChunks);
            }
        }

        return this.addOverlap(refinedChunks);
    }

    private splitLargeChunk(chunk: CodeChunk, originalCode: string): CodeChunk[] {
        const lines = chunk.content.split('\n');
        const subChunks: CodeChunk[] = [];
        let currentChunk = '';
        let currentStartLine = chunk.metadata.startLine;
        let currentLineCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineWithNewline = i === lines.length - 1 ? line : line + '\n';

            if (currentChunk.length + lineWithNewline.length > this.chunkSize && currentChunk.length > 0) {
                // Create a sub-chunk
                subChunks.push({
                    content: currentChunk.trim(),
                    metadata: {
                        startLine: currentStartLine,
                        endLine: currentStartLine + currentLineCount - 1,
                        language: chunk.metadata.language,
                        filePath: chunk.metadata.filePath,
                    }
                });

                currentChunk = lineWithNewline;
                currentStartLine = chunk.metadata.startLine + i;
                currentLineCount = 1;
            } else {
                currentChunk += lineWithNewline;
                currentLineCount++;
            }
        }

        // Add the last sub-chunk
        if (currentChunk.trim().length > 0) {
            subChunks.push({
                content: currentChunk.trim(),
                metadata: {
                    startLine: currentStartLine,
                    endLine: currentStartLine + currentLineCount - 1,
                    language: chunk.metadata.language,
                    filePath: chunk.metadata.filePath,
                }
            });
        }

        return subChunks;
    }

    private addOverlap(chunks: CodeChunk[]): CodeChunk[] {
        if (chunks.length <= 1 || this.chunkOverlap <= 0) {
            return chunks;
        }

        const overlappedChunks: CodeChunk[] = [];

        for (let i = 0; i < chunks.length; i++) {
            let content = chunks[i].content;
            const metadata = { ...chunks[i].metadata };

            // Add overlap from previous chunk
            if (i > 0 && this.chunkOverlap > 0) {
                const prevChunk = chunks[i - 1];
                const overlapText = prevChunk.content.slice(-this.chunkOverlap);
                content = overlapText + '\n' + content;
                metadata.startLine = Math.max(1, metadata.startLine - this.getLineCount(overlapText));
            }

            overlappedChunks.push({
                content,
                metadata
            });
        }

        return overlappedChunks;
    }

    private getLineCount(text: string): number {
        return text.split('\n').length;
    }

    /**
     * Check if a node type represents a definition/declaration in a given language
     */
    private isDefinitionNode(nodeType: string, language: string): boolean {
        const definitionTypes: Record<string, string[]> = {
            javascript: ['function_declaration', 'class_declaration', 'method_definition'],
            typescript: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration', 'type_alias_declaration'],
            python: ['function_definition', 'class_definition', 'async_function_definition'],
            java: ['method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration'],
            cpp: ['function_definition', 'class_specifier'],
            go: ['function_declaration', 'method_declaration', 'type_declaration'],
            rust: ['function_item', 'struct_item', 'enum_item', 'trait_item'],
            csharp: ['method_declaration', 'class_declaration', 'interface_declaration', 'struct_declaration'],
            scala: ['method_declaration', 'class_declaration', 'interface_declaration'],
            dart: ['class_definition', 'enum_declaration', 'mixin_declaration', 'function_signature', 'method_signature']
        };

        const types = definitionTypes[language.toLowerCase()];
        return types ? types.includes(nodeType) : false;
    }

    /**
     * Check if AST splitting is supported for the given language
     */
    static isLanguageSupported(language: string): boolean {
        const supportedLanguages = [
            'javascript', 'js', 'typescript', 'ts', 'python', 'py',
            'java', 'cpp', 'c++', 'c', 'go', 'rust', 'rs', 'cs', 'csharp', 'scala'
        ];
        return supportedLanguages.includes(language.toLowerCase());
    }
}
