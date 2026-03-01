import { useEffect, useRef, useState } from "react";

import type { ActionDraft, ActionStatusEvent } from "@mark/contracts";

import type { TaskNotification, TaskNotificationTone } from "../uiTypes";
import type { ActionTimelineItem } from "../useVoiceAgent";

type UseActionNotificationsInput = {
  actionTimeline: ActionTimelineItem[];
  pendingAction: ActionDraft | null;
  actionStatus: ActionStatusEvent | null;
};

const MAX_NOTIFICATIONS = 8;

export function useActionNotifications({
  actionTimeline,
  pendingAction,
  actionStatus
}: UseActionNotificationsInput): TaskNotification[] {
  const [notifications, setNotifications] = useState<TaskNotification[]>([]);
  const seenTimelineIdsRef = useRef(new Set<string>());
  const signatureToIdRef = useRef(new Map<string, string>());
  const platformByActionIdRef = useRef(new Map<string, string>());

  const upsertNotification = (input: {
    signature: string;
    actionId: string | null;
    revisionId: string | null;
    type: string;
    message: string;
    platformLabel: string;
    tone: TaskNotificationTone;
    createdAt: string;
  }): string => {
    const existingId = signatureToIdRef.current.get(input.signature);
    const id = existingId ?? createNotificationId(input.signature);
    signatureToIdRef.current.set(input.signature, id);

    setNotifications((prev) => {
      const nextNotification: TaskNotification = {
        id,
        signature: input.signature,
        actionId: input.actionId,
        revisionId: input.revisionId,
        type: input.type,
        message: input.message,
        platformLabel: input.platformLabel,
        tone: input.tone,
        visualState: "visible",
        createdAt: input.createdAt
      };

      const withoutCurrent = prev.filter((item) => item.id !== id);
      const next = [nextNotification, ...withoutCurrent];
      return next.slice(0, MAX_NOTIFICATIONS);
    });

    return id;
  };

  useEffect(() => {
    const ordered = [...actionTimeline].reverse();
    for (const item of ordered) {
      if (seenTimelineIdsRef.current.has(item.id)) {
        continue;
      }
      seenTimelineIdsRef.current.add(item.id);

      const signature = buildSignature(item.actionId, item.revisionId, item.type);
      const tone = classifyTimelineEvent(item.type, item.message);
      upsertNotification({
        signature,
        actionId: item.actionId,
        revisionId: item.revisionId,
        type: item.type,
        message: item.message,
        tone,
        platformLabel: resolvePlatformLabel(item.actionId, platformByActionIdRef.current),
        createdAt: item.createdAt
      });
    }
  }, [actionTimeline]);

  useEffect(() => {
    if (!actionStatus) {
      return;
    }

    const signature = buildSignature(actionStatus.actionId, actionStatus.revisionId, "action.status");
    const tone = classifyActionStatus(actionStatus);
    upsertNotification({
      signature,
      actionId: actionStatus.actionId,
      revisionId: actionStatus.revisionId,
      type: "action.status",
      message: actionStatus.message,
      tone,
      platformLabel: resolvePlatformLabel(actionStatus.actionId, platformByActionIdRef.current),
      createdAt: actionStatus.updatedAt
    });
  }, [actionStatus]);

  useEffect(() => {
    if (!pendingAction) {
      return;
    }

    const platform =
      pendingAction.toolkitSlug?.trim() || pendingAction.toolSlug?.trim() || resolvePlatformLabel(null, platformByActionIdRef.current);
    platformByActionIdRef.current.set(pendingAction.actionId, platform);

    const signature = buildSignature(pendingAction.actionId, pendingAction.revisionId, "action.proposed");
    upsertNotification({
      signature,
      actionId: pendingAction.actionId,
      revisionId: pendingAction.revisionId,
      type: "action.proposed",
      message: pendingAction.summary,
      tone: "approval",
      platformLabel: platform,
      createdAt: pendingAction.updatedAt
    });
  }, [pendingAction]);

  return notifications;
}

function buildSignature(actionId: string | null, revisionId: string | null, type: string): string {
  return `${actionId ?? "none"}:${revisionId ?? "none"}:${type}`;
}

function classifyTimelineEvent(
  type: string,
  message: string
): TaskNotificationTone {
  switch (type) {
    case "action.proposed":
    case "action.revised":
      return "approval";
    case "action.executed":
      return "success";
    case "action.failed":
    case "action.rejected":
      return "error";
    case "action.status":
      return classifyStatusMessage(message);
    default:
      return "working";
  }
}

function classifyActionStatus(actionStatus: ActionStatusEvent): TaskNotificationTone {
  switch (actionStatus.status) {
    case "pending_approval":
      return "approval";
    case "completed":
      return "success";
    case "rejected":
    case "failed":
      return "error";
    default:
      return "working";
  }
}

function classifyStatusMessage(message: string): TaskNotificationTone {
  const normalized = message.trim().toLowerCase();
  if (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("rejected") ||
    normalized.includes("reject")
  ) {
    return "error";
  }
  if (normalized.includes("completed") || normalized.includes("executed") || normalized.includes("done")) {
    return "success";
  }
  if (normalized.includes("approval")) {
    return "approval";
  }
  return "working";
}

function createNotificationId(signature: string): string {
  return `${signature}:${Date.now().toString(16)}:${Math.random().toString(16).slice(2, 7)}`;
}

function resolvePlatformLabel(actionId: string | null, platformByActionId: Map<string, string>): string {
  if (actionId) {
    const known = platformByActionId.get(actionId);
    if (known) {
      return known;
    }
  }
  return "agent-task";
}
