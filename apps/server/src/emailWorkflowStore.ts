import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { TriagedEmail } from "./gmailInboxTriage.js";

export type EmailWorkflowCategory = "respond_needed" | "must_know";
export type EmailWorkflowPhase = "idle" | "awaiting_choice" | "reviewing";
export type EmailWorkflowItemStatus = "triaged" | "selected" | "drafted" | "sent";

export type EmailWorkflowConversation = {
  phase: EmailWorkflowPhase;
  selectedCategory: EmailWorkflowCategory | null;
  selectedIndexByCategory: Record<EmailWorkflowCategory, number>;
  currentEmailId: string | null;
  lastDraft: string | null;
};

export type EmailWorkflowActionRef = {
  actionId: string;
  revisionId: string;
  toolSlug: string;
};

type EmailWorkflowDraftVersion = {
  versionId: string;
  createdAt: string;
  instruction: string;
  text: string;
};

type EmailWorkflowItemRecord = TriagedEmail & {
  status: EmailWorkflowItemStatus;
  selectedAt: string | null;
  sentAt: string | null;
  sentActionId: string | null;
  sentRevisionId: string | null;
  sentToolSlug: string | null;
  draftVersions: EmailWorkflowDraftVersion[];
};

type EmailWorkflowRecord = {
  workflowId: string;
  userId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  windowLabel: string;
  resolvedQuery: string;
  timeZone: string;
  scannedCount: number;
  optionalCount: number;
  capHit: boolean;
  respondNeededItems: EmailWorkflowItemRecord[];
  mustKnowItems: EmailWorkflowItemRecord[];
  conversation: EmailWorkflowConversation;
};

type DiskFormat = {
  workflows: EmailWorkflowRecord[];
};

export type EmailWorkflowSnapshot = {
  workflowId: string;
  userId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  windowLabel: string;
  resolvedQuery: string;
  timeZone: string;
  scannedCount: number;
  optionalCount: number;
  capHit: boolean;
  respondNeededItems: TriagedEmail[];
  mustKnowItems: TriagedEmail[];
  respondNeededCount: number;
  mustKnowCount: number;
  respondNeededDoneCount: number;
  mustKnowDoneCount: number;
  sentCount: number;
  conversation: EmailWorkflowConversation;
};

type CreateWorkflowParams = {
  userId: string;
  sessionId: string;
  windowLabel: string;
  resolvedQuery: string;
  timeZone: string;
  scannedCount: number;
  optionalCount: number;
  capHit: boolean;
  respondNeededItems: TriagedEmail[];
  mustKnowItems: TriagedEmail[];
};

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STORAGE_PATH = path.resolve(SERVER_ROOT, ".runtime/email-workflows.json");

export class EmailWorkflowStore {
  private readonly storagePath: string;
  private readonly byWorkflowId = new Map<string, EmailWorkflowRecord>();
  private readonly latestWorkflowIdByUser = new Map<string, string>();

  constructor(storagePath = DEFAULT_STORAGE_PATH) {
    this.storagePath = storagePath;
    this.loadFromDisk();
  }

  createFromTriage(params: CreateWorkflowParams): EmailWorkflowSnapshot {
    const now = new Date().toISOString();
    const workflowId = randomUUID();

    const record: EmailWorkflowRecord = {
      workflowId,
      userId: params.userId,
      sessionId: params.sessionId,
      createdAt: now,
      updatedAt: now,
      windowLabel: params.windowLabel,
      resolvedQuery: params.resolvedQuery,
      timeZone: params.timeZone,
      scannedCount: params.scannedCount,
      optionalCount: params.optionalCount,
      capHit: params.capHit,
      respondNeededItems: params.respondNeededItems.map((item) => createWorkflowItem(item)),
      mustKnowItems: params.mustKnowItems.map((item) => createWorkflowItem(item)),
      conversation: createInitialConversationState()
    };

    this.byWorkflowId.set(workflowId, record);
    this.latestWorkflowIdByUser.set(record.userId, workflowId);
    this.persistToDisk();
    return this.toSnapshot(record);
  }

  getByWorkflowId(workflowId: string): EmailWorkflowSnapshot | null {
    const record = this.byWorkflowId.get(workflowId);
    if (!record) {
      return null;
    }
    return this.toSnapshot(record);
  }

  getLatestByUser(userId: string): EmailWorkflowSnapshot | null {
    const workflowId = this.latestWorkflowIdByUser.get(userId);
    if (!workflowId) {
      return null;
    }
    return this.getByWorkflowId(workflowId);
  }

  clearByWorkflowId(workflowId: string): void {
    const existing = this.byWorkflowId.get(workflowId);
    if (!existing) {
      return;
    }

    this.byWorkflowId.delete(workflowId);
    const latestForUser = this.latestWorkflowIdByUser.get(existing.userId);
    if (latestForUser === workflowId) {
      const replacement = this.findLatestWorkflowForUser(existing.userId);
      if (replacement) {
        this.latestWorkflowIdByUser.set(existing.userId, replacement.workflowId);
      } else {
        this.latestWorkflowIdByUser.delete(existing.userId);
      }
    }
    this.persistToDisk();
  }

  updateConversation(workflowId: string, conversation: EmailWorkflowConversation): EmailWorkflowSnapshot | null {
    const record = this.byWorkflowId.get(workflowId);
    if (!record) {
      return null;
    }
    record.conversation = normalizeConversation(record, conversation);
    markSelectedItem(record);
    this.touchRecord(record);
    return this.toSnapshot(record);
  }

  recordDraft(workflowId: string, emailId: string, draftText: string, instruction: string): EmailWorkflowSnapshot | null {
    const record = this.byWorkflowId.get(workflowId);
    if (!record) {
      return null;
    }
    const located = locateEmail(record, emailId);
    if (!located) {
      return this.toSnapshot(record);
    }

    located.item.draftVersions.push({
      versionId: randomUUID(),
      createdAt: new Date().toISOString(),
      instruction,
      text: draftText
    });
    if (located.item.status !== "sent") {
      located.item.status = "drafted";
    }
    record.conversation.lastDraft = draftText;
    this.touchRecord(record);
    return this.toSnapshot(record);
  }

  markCurrentEmailSent(workflowId: string, action: EmailWorkflowActionRef): EmailWorkflowSnapshot | null {
    const record = this.byWorkflowId.get(workflowId);
    if (!record || !record.conversation.currentEmailId) {
      return null;
    }
    return this.markEmailSent(workflowId, record.conversation.currentEmailId, action);
  }

  markEmailSent(workflowId: string, emailId: string, action: EmailWorkflowActionRef): EmailWorkflowSnapshot | null {
    const record = this.byWorkflowId.get(workflowId);
    if (!record) {
      return null;
    }
    const located = locateEmail(record, emailId);
    if (!located) {
      return this.toSnapshot(record);
    }

    located.item.status = "sent";
    located.item.sentAt = new Date().toISOString();
    located.item.sentActionId = action.actionId;
    located.item.sentRevisionId = action.revisionId;
    located.item.sentToolSlug = action.toolSlug;
    if (record.conversation.currentEmailId === emailId) {
      record.conversation.lastDraft = null;
    }
    record.conversation = normalizeConversation(record, record.conversation);
    this.touchRecord(record);
    return this.toSnapshot(record);
  }

  private touchRecord(record: EmailWorkflowRecord): void {
    record.updatedAt = new Date().toISOString();
    this.latestWorkflowIdByUser.set(record.userId, record.workflowId);
    this.persistToDisk();
  }

  private toSnapshot(record: EmailWorkflowRecord): EmailWorkflowSnapshot {
    const normalizedConversation = normalizeConversation(record, record.conversation);
    record.conversation = normalizedConversation;

    const respondPending = getPendingItems(record, "respond_needed");
    const mustKnowPending = getPendingItems(record, "must_know");

    const respondNeededDoneCount = record.respondNeededItems.length - respondPending.length;
    const mustKnowDoneCount = record.mustKnowItems.length - mustKnowPending.length;
    const sentCount = respondNeededDoneCount + mustKnowDoneCount;

    return {
      workflowId: record.workflowId,
      userId: record.userId,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      windowLabel: record.windowLabel,
      resolvedQuery: record.resolvedQuery,
      timeZone: record.timeZone,
      scannedCount: record.scannedCount,
      optionalCount: record.optionalCount,
      capHit: record.capHit,
      respondNeededItems: respondPending.map(stripWorkflowFields),
      mustKnowItems: mustKnowPending.map(stripWorkflowFields),
      respondNeededCount: respondPending.length,
      mustKnowCount: mustKnowPending.length,
      respondNeededDoneCount,
      mustKnowDoneCount,
      sentCount,
      conversation: normalizedConversation
    };
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.storagePath)) {
        return;
      }
      const raw = readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as DiskFormat;
      const records = Array.isArray(parsed.workflows) ? parsed.workflows : [];
      for (const record of records) {
        if (!record || typeof record !== "object" || typeof record.workflowId !== "string") {
          continue;
        }
        this.byWorkflowId.set(record.workflowId, record);
      }
      this.rebuildLatestIndex();
    } catch {
      // Ignore malformed storage file and start fresh.
    }
  }

  private rebuildLatestIndex(): void {
    this.latestWorkflowIdByUser.clear();
    for (const record of this.byWorkflowId.values()) {
      const currentId = this.latestWorkflowIdByUser.get(record.userId);
      if (!currentId) {
        this.latestWorkflowIdByUser.set(record.userId, record.workflowId);
        continue;
      }
      const current = this.byWorkflowId.get(currentId);
      if (!current || Date.parse(record.updatedAt) > Date.parse(current.updatedAt)) {
        this.latestWorkflowIdByUser.set(record.userId, record.workflowId);
      }
    }
  }

  private findLatestWorkflowForUser(userId: string): EmailWorkflowRecord | null {
    let latest: EmailWorkflowRecord | null = null;
    for (const record of this.byWorkflowId.values()) {
      if (record.userId !== userId) {
        continue;
      }
      if (!latest || Date.parse(record.updatedAt) > Date.parse(latest.updatedAt)) {
        latest = record;
      }
    }
    return latest;
  }

  private persistToDisk(): void {
    const directory = path.dirname(this.storagePath);
    mkdirSync(directory, { recursive: true });
    const data: DiskFormat = {
      workflows: Array.from(this.byWorkflowId.values())
    };
    writeFileSync(this.storagePath, JSON.stringify(data, null, 2), "utf8");
  }
}

function createWorkflowItem(item: TriagedEmail): EmailWorkflowItemRecord {
  return {
    ...item,
    status: "triaged",
    selectedAt: null,
    sentAt: null,
    sentActionId: null,
    sentRevisionId: null,
    sentToolSlug: null,
    draftVersions: []
  };
}

function createInitialConversationState(): EmailWorkflowConversation {
  return {
    phase: "awaiting_choice",
    selectedCategory: null,
    selectedIndexByCategory: {
      respond_needed: 0,
      must_know: 0
    },
    currentEmailId: null,
    lastDraft: null
  };
}

function normalizeConversation(record: EmailWorkflowRecord, input: EmailWorkflowConversation): EmailWorkflowConversation {
  const base: EmailWorkflowConversation = {
    phase: input.phase,
    selectedCategory: input.selectedCategory,
    selectedIndexByCategory: {
      respond_needed: Number.isFinite(input.selectedIndexByCategory.respond_needed)
        ? Math.max(0, Math.trunc(input.selectedIndexByCategory.respond_needed))
        : 0,
      must_know: Number.isFinite(input.selectedIndexByCategory.must_know)
        ? Math.max(0, Math.trunc(input.selectedIndexByCategory.must_know))
        : 0
    },
    currentEmailId: input.currentEmailId,
    lastDraft: input.lastDraft ?? null
  };

  if (base.phase === "idle") {
    return {
      ...base,
      selectedCategory: null,
      currentEmailId: null
    };
  }

  if (!base.selectedCategory) {
    return {
      ...base,
      phase: "awaiting_choice",
      currentEmailId: null
    };
  }

  const items = getPendingItems(record, base.selectedCategory);
  if (items.length === 0) {
    return {
      ...base,
      phase: "awaiting_choice",
      selectedCategory: null,
      currentEmailId: null
    };
  }

  const requested = base.selectedIndexByCategory[base.selectedCategory];
  const bounded = Math.max(0, Math.min(requested, items.length - 1));
  const current = items[bounded];

  return {
    ...base,
    phase: "reviewing",
    selectedIndexByCategory: {
      ...base.selectedIndexByCategory,
      [base.selectedCategory]: bounded
    },
    currentEmailId: current.id
  };
}

function getPendingItems(record: EmailWorkflowRecord, category: EmailWorkflowCategory): EmailWorkflowItemRecord[] {
  const source = category === "respond_needed" ? record.respondNeededItems : record.mustKnowItems;
  return source.filter((item) => item.status !== "sent");
}

function locateEmail(
  record: EmailWorkflowRecord,
  emailId: string
): { category: EmailWorkflowCategory; index: number; item: EmailWorkflowItemRecord } | null {
  const respondIndex = record.respondNeededItems.findIndex((item) => item.id === emailId);
  if (respondIndex >= 0) {
    return {
      category: "respond_needed",
      index: respondIndex,
      item: record.respondNeededItems[respondIndex]
    };
  }

  const mustKnowIndex = record.mustKnowItems.findIndex((item) => item.id === emailId);
  if (mustKnowIndex >= 0) {
    return {
      category: "must_know",
      index: mustKnowIndex,
      item: record.mustKnowItems[mustKnowIndex]
    };
  }
  return null;
}

function markSelectedItem(record: EmailWorkflowRecord): void {
  const emailId = record.conversation.currentEmailId;
  if (!emailId) {
    return;
  }
  const located = locateEmail(record, emailId);
  if (!located) {
    return;
  }
  if (located.item.status === "triaged") {
    located.item.status = "selected";
    located.item.selectedAt = new Date().toISOString();
  }
}

function stripWorkflowFields(item: EmailWorkflowItemRecord): TriagedEmail {
  return {
    id: item.id,
    threadId: item.threadId,
    from: item.from,
    subject: item.subject,
    timestamp: item.timestamp,
    snippet: item.snippet,
    labelIds: item.labelIds,
    category: item.category,
    reason: item.reason
  };
}
