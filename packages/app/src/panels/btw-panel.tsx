import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useFetchQuery } from "@/data/query";
import { MessageCircleQuestionMark } from "lucide-react-native";
import { AppearanceText as Text } from "@/appearance/text";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore, type AgentBtwRecordView } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

const EMPTY_BTW_RECORD_MAP = new Map<string, AgentBtwRecordView>();

interface BtwRecordRowProps {
  record: AgentBtwRecordView;
  runningLabel: string;
}

function BtwRecordRow({ record, runningLabel }: BtwRecordRowProps) {
  const isRunning = record.status === "running" && !record.answer;
  const hasFailed =
    record.status === "error" || record.status === "cancelled" || record.status === "interrupted";

  let statusLine: ReactNode = null;
  if (isRunning) {
    statusLine = (
      <View style={styles.recordRunningRow}>
        <ThemedLoadingSpinner size="small" />
        <Text style={styles.recordMuted}>{runningLabel}</Text>
      </View>
    );
  } else if (hasFailed) {
    statusLine = (
      <Text style={styles.recordError} numberOfLines={6}>
        {record.error ?? record.status}
      </Text>
    );
  } else if (record.answer) {
    statusLine = (
      <Text style={styles.recordAnswer} numberOfLines={24}>
        {record.answer}
      </Text>
    );
  }

  return (
    <View style={styles.recordRow}>
      <Text style={styles.recordQuestion} numberOfLines={8}>
        {record.question}
      </Text>
      {statusLine}
    </View>
  );
}

function btwSortKey(record: AgentBtwRecordView): number {
  const raw = record.updatedAt ?? record.createdAt;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Date.parse(raw) || 0;
  return 0;
}

function BtwPanelPane() {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "btw", "BtwPanelPane requires a btw target");
  const agentId = target.agentId;
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // Subscribe to the stable inner Map: a selector that builds/sorts a new array
  // per read loops useSyncExternalStore forever (React error #185).
  const pushedRecordMap = useSessionStore(
    (state) => state.sessions[serverId]?.agentBtwRecords.get(agentId) ?? EMPTY_BTW_RECORD_MAP,
  );
  const pushedRecords = useMemo(() => [...pushedRecordMap.values()], [pushedRecordMap]);

  const historyQuery = useFetchQuery<AgentBtwRecordView[]>({
    queryKey: ["btw", serverId, agentId],
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 15_000,
    queryFn: async () => {
      if (!client) {
        return [];
      }
      return client.listBtwHistory({ agentId });
    },
  });

  const records = useMemo<AgentBtwRecordView[]>(() => {
    // Live pushed records win over the fetched snapshot; both sides are already
    // deduplicated by record id.
    const merged = new Map<string, AgentBtwRecordView>();
    for (const record of historyQuery.data ?? []) {
      merged.set(record.id, record);
    }
    for (const record of pushedRecords) {
      merged.set(record.id, record);
    }
    return [...merged.values()].sort((a, b) => btwSortKey(a) - btwSortKey(b));
  }, [historyQuery.data, pushedRecords]);

  const handleAsk = useCallback(async () => {
    const trimmed = question.trim();
    if (!client || trimmed.length === 0 || isAsking) {
      return;
    }
    setIsAsking(true);
    try {
      await client.askBtw({ agentId, question: trimmed });
      setQuestion("");
    } catch (error) {
      console.warn("[BtwPanelPane] askBtw failed", error);
      toast.error(toErrorMessage(error));
    } finally {
      setIsAsking(false);
    }
  }, [agentId, client, isAsking, question, toast]);

  const canAsk = question.trim().length > 0 && !isAsking && client !== null;
  const runningLabel = t("agentControls.btw.running");

  const submitQuestion = useCallback(() => {
    void handleAsk();
  }, [handleAsk]);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.recordList}
        contentContainerStyle={styles.recordListContent}
        keyboardShouldPersistTaps="handled"
      >
        {records.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.recordMuted}>{t("agentControls.btw.empty")}</Text>
          </View>
        ) : (
          records.map((record) => (
            <BtwRecordRow key={record.id} record={record} runningLabel={runningLabel} />
          ))
        )}
      </ScrollView>
      <View style={styles.askRow}>
        <AdaptiveTextInput
          initialValue={question}
          onChangeText={setQuestion}
          placeholder={t("agentControls.btw.inputPlaceholder")}
          onSubmitEditing={canAsk ? submitQuestion : undefined}
          style={styles.askInput}
          testID="agent-btw-input"
        />
        <Button
          variant="default"
          size="sm"
          disabled={!canAsk}
          loading={isAsking}
          onPress={submitQuestion}
          testID="agent-btw-ask"
        >
          {t("agentControls.btw.askNow")}
        </Button>
      </View>
    </View>
  );
}

function useBtwPanelDescriptor(
  _target: { kind: "btw"; agentId: string },
  _context: { serverId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: t("agentControls.btw.title"),
    subtitle: t("agentControls.btw.open"),
    tooltip: t("agentControls.btw.open"),
    titleState: "ready",
    icon: MessageCircleQuestionMark,
    statusBucket: null,
  };
}

export const btwPanelRegistration = definePanel("btw", {
  component: BtwPanelPane,
  useDescriptor: useBtwPanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  recordList: {
    flex: 1,
  },
  recordListContent: {
    paddingVertical: theme.spacing[1],
  },
  askRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  askInput: {
    flex: 1,
  },
  emptyState: {
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  recordRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  recordQuestion: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  recordAnswer: {
    color: theme.colors.foregroundMuted,
  },
  recordMuted: {
    color: theme.colors.foregroundMuted,
  },
  recordError: {
    color: theme.colors.destructive,
  },
  recordRunningRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
