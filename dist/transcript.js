import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'readline';
import { createHash } from 'node:crypto';
import { getHudPluginDir } from './claude-config-dir.js';
const TRANSCRIPT_CACHE_VERSION = 4;
let createReadStreamImpl = fs.createReadStream;
function normalizeTokenCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.trunc(value));
}
function normalizeSessionTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') {
        return undefined;
    }
    const raw = tokens;
    return {
        inputTokens: normalizeTokenCount(raw.inputTokens),
        outputTokens: normalizeTokenCount(raw.outputTokens),
        cacheCreationTokens: normalizeTokenCount(raw.cacheCreationTokens),
        cacheReadTokens: normalizeTokenCount(raw.cacheReadTokens),
    };
}
function normalizeUsage(usage) {
    return {
        inputTokens: normalizeTokenCount(usage?.input_tokens),
        outputTokens: normalizeTokenCount(usage?.output_tokens),
        cacheCreationTokens: normalizeTokenCount(usage?.cache_creation_input_tokens),
        cacheReadTokens: normalizeTokenCount(usage?.cache_read_input_tokens),
    };
}
function getTranscriptCachePath(transcriptPath, homeDir) {
    const hash = createHash('sha256').update(path.resolve(transcriptPath)).digest('hex');
    return path.join(getHudPluginDir(homeDir), 'transcript-cache', `${hash}.json`);
}
function canonicalizeTranscriptPath(transcriptPath) {
    try {
        return fs.realpathSync(transcriptPath);
    }
    catch {
        return null;
    }
}
function readTranscriptFileState(transcriptPath) {
    try {
        const stat = fs.statSync(transcriptPath);
        if (!stat.isFile()) {
            return null;
        }
        return {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
        };
    }
    catch {
        return null;
    }
}
function serializeTranscriptData(data) {
    return {
        tools: data.tools.map((tool) => ({
            ...tool,
            startTime: tool.startTime.toISOString(),
            endTime: tool.endTime?.toISOString(),
        })),
        cumulativeToolCounts: data.cumulativeToolCounts,
        agents: data.agents.map((agent) => ({
            ...agent,
            startTime: agent.startTime.toISOString(),
            endTime: agent.endTime?.toISOString(),
        })),
        todos: data.todos.map((todo) => ({ ...todo })),
        assistantCount: data.assistantCount,
        sessionStart: data.sessionStart?.toISOString(),
        sessionName: data.sessionName,
        lastAssistantResponseAt: data.lastAssistantResponseAt?.toISOString(),
        sessionTokens: data.sessionTokens,
        lastCompactBoundaryAt: data.lastCompactBoundaryAt?.toISOString(),
        lastCompactPostTokens: data.lastCompactPostTokens,
    };
}
function deserializeTranscriptData(data) {
    return {
        tools: data.tools.map((tool) => ({
            ...tool,
            startTime: new Date(tool.startTime),
            endTime: tool.endTime ? new Date(tool.endTime) : undefined,
        })),
        cumulativeToolCounts: data.cumulativeToolCounts ?? {},
        agents: data.agents.map((agent) => ({
            ...agent,
            startTime: new Date(agent.startTime),
            endTime: agent.endTime ? new Date(agent.endTime) : undefined,
        })),
        todos: data.todos.map((todo) => ({ ...todo })),
        assistantCount: typeof data.assistantCount === 'number' ? data.assistantCount : 0,
        sessionStart: data.sessionStart ? new Date(data.sessionStart) : undefined,
        sessionName: data.sessionName,
        lastAssistantResponseAt: data.lastAssistantResponseAt ? new Date(data.lastAssistantResponseAt) : undefined,
        sessionTokens: normalizeSessionTokens(data.sessionTokens),
        lastCompactBoundaryAt: data.lastCompactBoundaryAt ? new Date(data.lastCompactBoundaryAt) : undefined,
        lastCompactPostTokens: typeof data.lastCompactPostTokens === 'number' ? data.lastCompactPostTokens : undefined,
    };
}
function readTranscriptCache(transcriptPath, state) {
    try {
        const cachePath = getTranscriptCachePath(transcriptPath, os.homedir());
        const raw = fs.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== TRANSCRIPT_CACHE_VERSION
            || !parsed.data
            || !parsed.transcriptPath
            || parsed.transcriptPath !== path.resolve(transcriptPath)
            || parsed.transcriptState?.mtimeMs !== state.mtimeMs
            || parsed.transcriptState?.size !== state.size) {
            return null;
        }
        return deserializeTranscriptData(parsed.data);
    }
    catch {
        return null;
    }
}
function writeTranscriptCache(transcriptPath, state, data) {
    try {
        const cachePath = getTranscriptCachePath(transcriptPath, os.homedir());
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const payload = {
            version: TRANSCRIPT_CACHE_VERSION,
            transcriptPath: path.resolve(transcriptPath),
            transcriptState: state,
            data: serializeTranscriptData(data),
        };
        fs.writeFileSync(cachePath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    }
    catch {
        // Cache failures are non-fatal; fall back to fresh parsing next time.
    }
}
export async function parseTranscript(transcriptPath) {
    const result = {
        tools: [],
        agents: [],
        todos: [],
    };
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return result;
    }
    const canonicalTranscriptPath = canonicalizeTranscriptPath(transcriptPath);
    if (!canonicalTranscriptPath) {
        return result;
    }
    const transcriptState = readTranscriptFileState(canonicalTranscriptPath);
    if (!transcriptState) {
        return result;
    }
    const cached = readTranscriptCache(canonicalTranscriptPath, transcriptState);
    if (cached) {
        return cached;
    }
    const toolMap = new Map();
    const cumulativeToolCounts = new Map();
    const agentMap = new Map();
    let latestTodos = [];
    const taskIdToIndex = new Map();
    const queueCompletionMap = new Map();
    let assistantCount = 0;
    let latestSlug;
    let customTitle;
    let lastCompactBoundaryAt;
    let lastCompactPostTokens;
    const sessionTokens = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
    };
    const usageByAssistantMessageId = new Map();
    let parsedCleanly = false;
    try {
        const fileStream = createReadStreamImpl(canonicalTranscriptPath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            if (!line.trim())
                continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
                    customTitle = entry.customTitle;
                }
                else if (typeof entry.slug === 'string') {
                    latestSlug = entry.slug;
                }
                // Accumulate token usage from assistant messages
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = normalizeUsage(entry.message.usage);
                    const messageId = typeof entry.message.id === 'string' && entry.message.id.trim().length > 0
                        ? entry.message.id
                        : null;
                    if (!messageId) {
                        assistantCount += 1;
                        sessionTokens.inputTokens += usage.inputTokens;
                        sessionTokens.outputTokens += usage.outputTokens;
                        sessionTokens.cacheCreationTokens += usage.cacheCreationTokens;
                        sessionTokens.cacheReadTokens += usage.cacheReadTokens;
                    }
                    else {
                        const previous = usageByAssistantMessageId.get(messageId);
                        if (!previous) {
                            assistantCount += 1;
                            sessionTokens.inputTokens += usage.inputTokens;
                            sessionTokens.outputTokens += usage.outputTokens;
                            sessionTokens.cacheCreationTokens += usage.cacheCreationTokens;
                            sessionTokens.cacheReadTokens += usage.cacheReadTokens;
                            usageByAssistantMessageId.set(messageId, usage);
                        }
                        else {
                            const inputDelta = Math.max(usage.inputTokens - previous.inputTokens, 0);
                            const outputDelta = Math.max(usage.outputTokens - previous.outputTokens, 0);
                            const cacheCreationDelta = Math.max(usage.cacheCreationTokens - previous.cacheCreationTokens, 0);
                            const cacheReadDelta = Math.max(usage.cacheReadTokens - previous.cacheReadTokens, 0);
                            sessionTokens.inputTokens += inputDelta;
                            sessionTokens.outputTokens += outputDelta;
                            sessionTokens.cacheCreationTokens += cacheCreationDelta;
                            sessionTokens.cacheReadTokens += cacheReadDelta;
                            if (inputDelta > 0 || outputDelta > 0 || cacheCreationDelta > 0 || cacheReadDelta > 0) {
                                usageByAssistantMessageId.set(messageId, {
                                    inputTokens: Math.max(previous.inputTokens, usage.inputTokens),
                                    outputTokens: Math.max(previous.outputTokens, usage.outputTokens),
                                    cacheCreationTokens: Math.max(previous.cacheCreationTokens, usage.cacheCreationTokens),
                                    cacheReadTokens: Math.max(previous.cacheReadTokens, usage.cacheReadTokens),
                                });
                            }
                        }
                    }
                }
                // Track Claude Code's compact_boundary marker. Both manual (/compact)
                // and auto compaction emit this system entry with compactMetadata; we
                // take the most recent one's timestamp so callers can distinguish a
                // legitimate post-compact zero frame from a transient stdin glitch.
                if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
                    const ts = entry.timestamp ? new Date(entry.timestamp) : null;
                    if (ts && !Number.isNaN(ts.getTime())) {
                        if (!lastCompactBoundaryAt || ts.getTime() > lastCompactBoundaryAt.getTime()) {
                            lastCompactBoundaryAt = ts;
                            const post = entry.compactMetadata?.postTokens;
                            lastCompactPostTokens = typeof post === 'number' && Number.isFinite(post) && post >= 0
                                ? Math.trunc(post)
                                : undefined;
                        }
                    }
                }
                // Capture accurate background-agent completion timestamps from queue-operation entries.
                // The tool_result timestamp in the parent transcript is written at launch time, not
                // when the agent actually finishes, so we override with the enqueue timestamp.
                if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && entry.content) {
                    const taskIdMatch = entry.content.match(/<task-id>([^<]+)<\/task-id>/);
                    const toolUseIdMatch = entry.content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
                    if (taskIdMatch && toolUseIdMatch && entry.timestamp) {
                        const ts = new Date(entry.timestamp);
                        if (!Number.isNaN(ts.getTime())) {
                            queueCompletionMap.set(toolUseIdMatch[1], ts);
                        }
                    }
                }
                processEntry(entry, toolMap, cumulativeToolCounts, agentMap, taskIdToIndex, latestTodos, result);
            }
            catch {
                // Skip malformed lines
            }
        }
        parsedCleanly = true;
    }
    catch {
        // Return partial results on error
    }
    // Resolve agent completion: prefer queue-operation timestamps (accurate for
    // background agents), fall back to tool_result timestamps (inline agents).
    // Status is deferred so background agents show ◐ until they truly finish.
    for (const [toolUseId, endTime] of queueCompletionMap) {
        const agent = agentMap.get(toolUseId);
        if (agent?.background) {
            agent.endTime = endTime;
            agent.status = 'completed';
        }
    }
    for (const agent of agentMap.values()) {
        if (agent.status === 'running' && agent.endTime) {
            agent.status = 'completed';
        }
    }
    result.tools = Array.from(toolMap.values()).slice(-20);
    result.cumulativeToolCounts = Object.fromEntries(cumulativeToolCounts);
    result.agents = Array.from(agentMap.values()).slice(-10);
    result.todos = latestTodos;
    result.assistantCount = assistantCount;
    result.sessionName = customTitle ?? latestSlug;
    result.sessionTokens = sessionTokens;
    result.lastCompactBoundaryAt = lastCompactBoundaryAt;
    result.lastCompactPostTokens = lastCompactPostTokens;
    if (parsedCleanly) {
        writeTranscriptCache(canonicalTranscriptPath, transcriptState, result);
    }
    return result;
}
export function _setCreateReadStreamForTests(impl) {
    createReadStreamImpl = impl ?? fs.createReadStream;
}
function processEntry(entry, toolMap, cumulativeToolCounts, agentMap, taskIdToIndex, latestTodos, result) {
    const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();
    const hasValidTimestamp = !Number.isNaN(timestamp.getTime());
    if (!result.sessionStart && entry.timestamp && hasValidTimestamp) {
        result.sessionStart = timestamp;
    }
    if (entry.type === 'assistant' && entry.timestamp && hasValidTimestamp) {
        result.lastAssistantResponseAt = timestamp;
    }
    const content = entry.message?.content;
    if (!content || !Array.isArray(content))
        return;
    for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) {
            const toolEntry = {
                id: block.id,
                name: block.name,
                target: extractTarget(block.name, block.input),
                status: 'running',
                startTime: timestamp,
            };
            if (block.name === 'Task' || block.name === 'Agent') {
                const input = block.input;
                const agentEntry = {
                    id: block.id,
                    type: input?.subagent_type ?? 'agent',
                    model: input?.model ?? undefined,
                    description: input?.description ?? undefined,
                    status: 'running',
                    startTime: timestamp,
                    background: input?.run_in_background === true,
                };
                agentMap.set(block.id, agentEntry);
            }
            else if (block.name === 'TodoWrite') {
                const input = block.input;
                if (input?.todos && Array.isArray(input.todos)) {
                    // Build a FIFO queue of taskIds per content string, ordered by the
                    // old array position. Two todos that share the same content must
                    // each get their own taskId back after the rebuild, so we cannot
                    // collapse duplicates to one index.
                    const contentToTaskIds = new Map();
                    const taskIdsByOldIndex = [];
                    for (const [taskId, idx] of taskIdToIndex) {
                        if (idx < latestTodos.length) {
                            taskIdsByOldIndex.push([idx, taskId]);
                        }
                    }
                    taskIdsByOldIndex.sort((a, b) => a[0] - b[0]);
                    for (const [idx, taskId] of taskIdsByOldIndex) {
                        const content = latestTodos[idx].content;
                        const ids = contentToTaskIds.get(content) ?? [];
                        ids.push(taskId);
                        contentToTaskIds.set(content, ids);
                    }
                    latestTodos.length = 0;
                    taskIdToIndex.clear();
                    latestTodos.push(...input.todos);
                    // Consume one queued taskId per new todo that matches by content,
                    // so duplicate-content items still each get their own taskId.
                    for (let i = 0; i < latestTodos.length; i++) {
                        const ids = contentToTaskIds.get(latestTodos[i].content);
                        if (ids && ids.length > 0) {
                            const taskId = ids.shift();
                            taskIdToIndex.set(taskId, i);
                            if (ids.length === 0) {
                                contentToTaskIds.delete(latestTodos[i].content);
                            }
                        }
                    }
                }
            }
            else if (block.name === 'TaskCreate') {
                const input = block.input;
                const subject = typeof input?.subject === 'string' ? input.subject : '';
                const description = typeof input?.description === 'string' ? input.description : '';
                const content = subject || description || 'Untitled task';
                const status = normalizeTaskStatus(input?.status) ?? 'pending';
                latestTodos.push({ content, status });
                const rawTaskId = input?.taskId;
                const taskId = typeof rawTaskId === 'string' || typeof rawTaskId === 'number'
                    ? String(rawTaskId)
                    : block.id;
                if (taskId) {
                    taskIdToIndex.set(taskId, latestTodos.length - 1);
                }
            }
            else if (block.name === 'TaskUpdate') {
                const input = block.input;
                const index = resolveTaskIndex(input?.taskId, taskIdToIndex, latestTodos);
                if (index !== null) {
                    const status = normalizeTaskStatus(input?.status);
                    if (status) {
                        latestTodos[index].status = status;
                    }
                    const subject = typeof input?.subject === 'string' ? input.subject : '';
                    const description = typeof input?.description === 'string' ? input.description : '';
                    const content = subject || description;
                    if (content) {
                        latestTodos[index].content = content;
                    }
                }
            }
            else {
                toolMap.set(block.id, toolEntry);
            }
        }
        if (block.type === 'tool_result' && block.tool_use_id) {
            const tool = toolMap.get(block.tool_use_id);
            if (tool && tool.status === 'running') {
                tool.status = block.is_error ? 'error' : 'completed';
                tool.endTime = timestamp;
                const previousCount = cumulativeToolCounts.get(tool.name) ?? 0;
                cumulativeToolCounts.set(tool.name, previousCount + 1);
            }
            const agent = agentMap.get(block.tool_use_id);
            if (agent && !agent.background) {
                agent.endTime = timestamp;
            }
        }
    }
}
function extractTarget(toolName, input) {
    if (!input)
        return undefined;
    switch (toolName) {
        case 'Read':
        case 'Write':
        case 'Edit':
            return input.file_path ?? input.path;
        case 'Glob':
            return input.pattern;
        case 'Grep':
            return input.pattern;
        case 'Skill':
            return typeof input.skill === 'string' && input.skill.trim().length > 0
                ? input.skill
                : undefined;
        case 'Bash':
            const cmd = input.command;
            return cmd?.slice(0, 30) + (cmd?.length > 30 ? '...' : '');
    }
    return undefined;
}
function resolveTaskIndex(taskId, taskIdToIndex, latestTodos) {
    if (typeof taskId === 'string' || typeof taskId === 'number') {
        const key = String(taskId);
        const mapped = taskIdToIndex.get(key);
        if (typeof mapped === 'number') {
            return mapped;
        }
        if (/^\d+$/.test(key)) {
            const numericIndex = Number.parseInt(key, 10) - 1;
            if (numericIndex >= 0 && numericIndex < latestTodos.length) {
                return numericIndex;
            }
        }
    }
    return null;
}
function normalizeTaskStatus(status) {
    if (typeof status !== 'string')
        return null;
    switch (status) {
        case 'pending':
        case 'not_started':
            return 'pending';
        case 'in_progress':
        case 'running':
            return 'in_progress';
        case 'completed':
        case 'complete':
        case 'done':
            return 'completed';
        default:
            return null;
    }
}
//# sourceMappingURL=transcript.js.map