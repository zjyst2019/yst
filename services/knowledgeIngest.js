// services/knowledgeIngest.js
const fs = require('fs');
const path = require('path');
const claudeService = require('./claude');
const logger = require('./logger');

/**
 * Knowledge base ingestion service.
 * CLAUDE.md is NOT embedded in prompts — executeClaude already sends it
 * as system prompt (SDK: system field, CLI: --append-system-prompt-file).
 * The prompts below only describe the task; Claude gets structure rules from system prompt.
 */
class KnowledgeIngest {
    async ingest(question, answer, userConfig, requirement) {
        const ingestId = 'ingest_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const workDir = claudeService.getWorkDir();
        const apiKeyPrefix = userConfig?.apiKey ? userConfig.apiKey.substring(0, 8) + '...' : 'default';

        logger.logIngest({
            source: 'supplement',
            question: question.substring(0, 100),
            status: 'started',
            apiKey: apiKeyPrefix
        });

        const generatedFile = await this.generateMdFile(question, answer, workDir, userConfig, null, requirement);

        if (generatedFile) {
            console.log(`[Knowledge Ingest] Created: ${generatedFile}`);
            logger.logIngest({
                source: 'supplement',
                question: question.substring(0, 100),
                status: 'success',
                kbPath: generatedFile,
                apiKey: apiKeyPrefix
            });

            const qaCache = require('./qaCache');
            const filename = path.basename(generatedFile);
            qaCache.clearCacheByFiles([filename]);
            qaCache.scanKnowledgeBase();
        } else {
            logger.logIngest({
                source: 'supplement',
                question: question.substring(0, 100),
                status: 'failed',
                error: 'Failed to generate MD file',
                apiKey: apiKeyPrefix
            });
        }

        this.cleanupTemp(workDir, ingestId);
    }

    /** @param {string} ingestId */
    async generateMdFile(question, answer, workDir, userConfig, ingestId, requirement) {
        const tempId = ingestId || 'gen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const prompt = this.buildPrompt(question, answer, tempId, requirement);

        return new Promise((resolve) => {
            claudeService.executeClaude(
                'md-' + tempId,
                prompt,
                [],
                userConfig || null,
                () => {},
                (content) => {
                    const result = this.parseResult(content);
                    if (result && result.filePath) {
                        const fullPath = path.resolve(workDir, result.filePath);
                        if (!fullPath.startsWith(path.resolve(workDir))) {
                            console.log(`[Knowledge Ingest] Rejected path outside workDir: ${result.filePath}`);
                            resolve(null);
                            return;
                        }
                        const dir = path.dirname(fullPath);
                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }
                        fs.writeFileSync(fullPath, result.content, 'utf-8');
                        resolve(fullPath);
                    } else {
                        console.log('[Knowledge Ingest] Failed to parse Claude response');
                        resolve(null);
                    }
                },
                (error) => {
                    console.log(`[Knowledge Ingest] Error: ${error}`);
                    resolve(null);
                }
            );
        }).finally(() => {
            this.cleanupTemp(workDir, tempId);
        });
    }

    // Ingest a file by path — Claude reads it with its built-in format support
    async ingestFile(filePath, userConfig, extraPrompt) {
        const ingestId = 'ingest_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const workDir = claudeService.getWorkDir();
        const filename = path.basename(filePath);
        const apiKeyPrefix = userConfig?.apiKey ? userConfig.apiKey.substring(0, 8) + '...' : 'default';

        logger.logIngest({
            source: 'file_upload',
            file: filename,
            filePath: filePath,
            status: 'started',
            apiKey: apiKeyPrefix
        });

        const prompt = this.buildFilePrompt(filePath, extraPrompt, ingestId);

        return new Promise((resolve) => {
            claudeService.executeClaude(
                'file-' + ingestId,
                prompt,
                [],
                userConfig || null,
                () => {},
                (content) => {
                    const result = this.parseResult(content);
                    if (result && result.filePath) {
                        const fullPath = path.resolve(workDir, result.filePath);
                        if (!fullPath.startsWith(path.resolve(workDir))) {
                            logger.logIngest({
                                source: 'file_upload',
                                file: filename,
                                status: 'failed',
                                error: 'Rejected path outside workDir: ' + result.filePath,
                                apiKey: apiKeyPrefix
                            });
                            resolve(null);
                            return;
                        }
                        const dir = path.dirname(fullPath);
                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }
                        fs.writeFileSync(fullPath, result.content, 'utf-8');

                        const qaCache = require('./qaCache');
                        qaCache.clearCacheByFiles([path.basename(fullPath)]);
                        qaCache.scanKnowledgeBase();

                        console.log(`[Knowledge Ingest] File ingested: ${filePath} → ${fullPath}`);
                        logger.logIngest({
                            source: 'file_upload',
                            file: filename,
                            status: 'success',
                            kbPath: fullPath,
                            apiKey: apiKeyPrefix
                        });
                        resolve(fullPath);
                    } else {
                        logger.logIngest({
                            source: 'file_upload',
                            file: filename,
                            status: 'failed',
                            error: 'Failed to parse Claude response',
                            apiKey: apiKeyPrefix
                        });
                        console.error(`[Knowledge Ingest] ${filename}: Claude returned no valid output`);
                        resolve(null);
                    }
                },
                (error) => {
                    logger.logIngest({
                        source: 'file_upload',
                        file: filename,
                        status: 'failed',
                        error: error,
                        apiKey: apiKeyPrefix
                    });
                    console.error(`[Knowledge Ingest] ${filename}: ${error}`);
                    resolve(null);
                }
            );
        }).finally(() => {
            this.cleanupTemp(workDir, ingestId);
        });
    }

    buildFilePrompt(filePath, extraPrompt, ingestId) {
        const extra = extraPrompt
            ? `\n用户附加的处理提示：${extraPrompt}\n`
            : '';

        return `请读取以下文件，分析其内容，按照系统提示词中的知识库结构规范，生成标准格式的 markdown 文件。

文件路径：${filePath}
${extra}
请先使用 Read 工具读取该文件（支持 PDF、DOCX、XLSX、PPTX、MD、TXT、CSV 等格式），然后分析内容，按以下 JSON 格式返回，不要包含其他内容：
{
  "filePath": "相对于知识库根目录的文件路径，如 wiki/guide/acl-config.md",
  "content": "markdown 文件内容"
}

注意：
1. 文件路径和命名遵循系统提示词中的 CLAUDE.md 规范
2. 提取文件中的关键技术信息，以知识库文档的方式组织
3. 标题要清晰反映文档核心内容
4. 保留所有技术细节、数据和示例
5. filePath 不能包含 .. 或 ~ 等特殊路径符号
6. 如果处理过程中需要创建临时脚本或文件，请放在 temp/${ingestId}/ 目录下`;
    }

    buildPrompt(question, answer, ingestId, requirement) {
        const requirementSection = requirement
            ? `处理要求（请严格按此要求处理知识内容）：
${requirement}

`
            : '';

        return `请根据以下信息，按照系统提示词中的知识库结构规范，生成一个标准格式的 markdown 文件。

知识内容：
${answer}

${requirementSection}原始问题：
${question}

请按以下 JSON 格式返回，不要包含其他内容：
{
  "filePath": "相对于知识库根目录的文件路径，如 wiki/guide/acl-config.md",
  "content": "markdown 文件内容"
}

注意：
1. 文件路径和命名遵循系统提示词中的 CLAUDE.md 规范
2. 内容的组织方式与知识库现有文件保持一致
3. 标题要清晰反映问题核心
4. 只保留技术细节和示例
5. filePath 不能包含 .. 或 ~ 等特殊路径符号`;
    }

    // When user doesn't follow the template, use AI to separate knowledge from instructions
    async analyzeContent(rawContent, userConfig) {
        const prompt = `请分析以下用户输入的内容，将其分为"知识内容"和"处理要求"两部分。

用户输入的内容可能混合了知识内容和处理指令（如"提取关键参数"、"单独列出"、"重点关注XX"等）。
请智能判断并提取：

- "知识内容"：用户想要补充到知识库中的技术知识
- "处理要求"：用户对如何处理/组织这些知识的指令（如果没有则为空字符串）

按以下 JSON 格式返回，不要包含其他内容：
{
  "knowledgeContent": "提取出的纯知识内容",
  "requirement": "提取出的处理要求，如果没有则为空字符串"
}

用户输入的内容：
${rawContent}`;

        return new Promise((resolve) => {
            claudeService.executeClaude(
                'analyze-' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                prompt,
                [],
                userConfig || null,
                () => {},
                (content) => {
                    try {
                        const jsonMatch = content.match(/\{[\s\S]*"knowledgeContent"[\s\S]*\}/);
                        if (jsonMatch) {
                            const result = JSON.parse(jsonMatch[0]);
                            resolve({
                                knowledgeContent: result.knowledgeContent || rawContent,
                                requirement: result.requirement || ''
                            });
                            return;
                        }
                    } catch (e) {
                        // Fall through to fallback
                    }
                    resolve({ knowledgeContent: rawContent, requirement: '' });
                },
                () => {
                    resolve({ knowledgeContent: rawContent, requirement: '' });
                }
            );
        });
    }

    // Clean up temp subdirectory created during a specific ingestion
    cleanupTemp(workDir, ingestId) {
        if (!ingestId) return;
        const tempDir = path.join(workDir, 'temp', ingestId);
        if (fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
                console.log(`[Knowledge Ingest] Cleaned up temp/${ingestId}/ directory`);
            } catch (e) {
                console.log(`[Knowledge Ingest] Failed to clean temp/${ingestId}/:`, e.message);
            }
        }
    }

    parseResult(text) {
        try {
            const jsonMatch = text.match(/\{[\s\S]*"filePath"[\s\S]*"content"[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return null;
        } catch (e) {
            return null;
        }
    }
}

module.exports = new KnowledgeIngest();
