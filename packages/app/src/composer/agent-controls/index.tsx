import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import {
  View,
  Pressable,
  Keyboard,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { Settings2, MessageCircleQuestionMark } from "lucide-react-native";
import { readSelectOption, type ComposerOptionControls } from "@/agent-controls/option-controls";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import {
  buildProviderSelectorProviders,
  buildSelectorProvider,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderDefinition } from "@/utils/provider-definitions";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import {
  AgentModeControl,
  useLiveAgentModeControl,
  type AgentModeControlValue,
} from "@/composer/agent-controls/mode-control";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type {
  AgentOptionControl,
  JsonValue,
  ProviderOptions,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import {
  getAgentControlHintKey,
  resolveAgentModelSelection,
  resolveProviderSnapshotEntry,
} from "@/composer/agent-controls/utils";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  controlSizingForLayout,
  TOOLBAR_CONTROL_GAP,
  toolbarGlyphColor,
  type ToolbarGlyphs,
  toolbarSlot,
} from "@/components/ui/control-geometry";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  useAgentControlCommandCenterActions,
  type AgentControlCommandCenterSource,
} from "@/command-center/agent-control-registration";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import {
  composerToolbarGeometry,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  type ComposerControlDensity,
  type ComposerControlPresentation,
} from "@/composer/agent-controls/layout";
import { ComposerControlLayoutProvider } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import {
  ComposerControls,
  ControlTooltipHint,
  type ComposerControlItem,
} from "@/composer/agent-controls/composer-control";
import {
  useAgentControlItems,
  useEffortCycleShortcut,
  useModelPickerShortcut,
} from "@/composer/agent-controls/control-items";
import { CompactModelSheet } from "@/composer/agent-controls/model-sheet";
import { useComposerSheetBridge } from "@/composer/agent-controls/sheet-bridge";
import { draftComposerAgent } from "@/composer/draft/composer-agent";
import { agentComposer } from "@/composer/agent-composer";
import { composerModelFromHalves } from "@/composer/halves-model";
import { ComposerModelProvider } from "@/composer/model";
import { ComposerAgentProvider, useComposerInput } from "@/composer/session";
import { PluginComposerItems, usePluginComposerItemCount } from "@/plugins/composer-items";
import {
  PluginToolbarSlot,
  usePluginToolbarWidth,
} from "@/composer/agent-controls/plugin-toolbar-slot";
import {
  useAgentProfileEditor,
  useAgentProfilePicker,
  type AgentProfile,
  type AgentProfileApplyTarget,
  type AgentProfileEditorControls,
  type AgentProfilePicker,
  type AgentProfileSeed,
  type DraftAgentProfileControls,
} from "@/agent-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

interface AgentControlOption {
  id: string;
  label: string;
}

const EMPTY_AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [];
const EMPTY_OPTIONS: ProviderOptions = {};

/**
 * Opens the agent's Side-questions pane: the Explorer dock pane when the workspace is split,
 * the main pane otherwise. The workspace key comes from the workspace context, not the agent
 * record — draft records have no workspaceId, which would silently no-op the open.
 */
function useOpenBtwPanel(
  modelSelectorServerId: string | null | undefined,
  btwAgentId: string | null | undefined,
  workspaceId: string | null | undefined,
) {
  return useCallback(() => {
    // TEMP-DIAGNOSTIC: identifies which guard swallows the press in packaged builds.
    console.warn("[btw] open requested", {
      modelSelectorServerId,
      btwAgentId,
      workspaceId,
    });
    if (!btwAgentId || !modelSelectorServerId || !workspaceId) {
      console.warn("[btw] blocked: empty guard value");
      return;
    }
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: modelSelectorServerId,
      workspaceId,
    });
    if (!workspaceKey) {
      console.warn("[btw] blocked: no workspaceKey");
      return;
    }
    const layoutStore = useWorkspaceLayoutStore.getState();
    const explorerPaneId = selectExplorerSidebarPaneId(layoutStore, workspaceKey);
    const tabId = layoutStore.openTab({
      workspaceKey,
      target: { kind: "btw", agentId: btwAgentId },
      intent: "reveal",
      placement: explorerPaneId ? { mode: "prefer", paneId: explorerPaneId } : undefined,
    });
    console.warn("[btw] openTab result", { tabId, explorerPaneId });
  }, [btwAgentId, modelSelectorServerId, workspaceId]);
}

function toFeatureControls(optionControls: ComposerOptionControls | undefined) {
  return (optionControls?.controls ?? []).map((control) => {
    if (control.type === "toggle") return { type: "toggle" as const };
    if (control.desktopTrigger === "icon") return { type: "select" as const, label: null };
    const selected = readSelectOption(control, optionControls?.options ?? {});
    const choice = control.choices.find((candidate) => candidate.value === selected);
    return {
      type: "select" as const,
      label: choice?.label ?? control.label,
    };
  });
}

function toThinkingPicker(input: {
  canSelectThinking: boolean;
  options: AgentControlOption[] | undefined;
  selectedThinkingOptionId: string | undefined;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  displayThinking: string | null | undefined;
}) {
  if (!input.canSelectThinking || !input.onSelectThinkingOption) {
    return null;
  }
  return {
    options: input.options ?? [],
    selectedId: input.selectedThinkingOptionId,
    onSelect: input.onSelectThinkingOption,
    displayLabel: input.displayThinking ?? "",
  };
}

function isSet<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Tracks the toolbar's measured width and folds the density when the budget shrinks. Folding
 * swaps the toolbar controls for the model sheet and back, so `onFold` must close whatever menu
 * or sheet belonged to controls that are gone.
 */
function useFoldedToolbarDensity(input: {
  controls: Parameters<typeof resolveComposerControlDensity>[0]["controls"];
  geometry: Parameters<typeof resolveComposerControlDensity>[0]["geometry"];
  minimumDensity: ComposerControlDensity;
  onFold: () => void;
}) {
  const { controls, geometry, minimumDensity, onFold } = input;
  const [density, setDensity] = useState<ComposerControlDensity>(minimumDensity);
  const densityRef = useRef<ComposerControlDensity>(minimumDensity);
  const availableWidthRef = useRef(0);

  const updateDensityForWidth = useCallback(
    (availableWidth: number) => {
      const nextDensity = resolveComposerControlDensity({
        availableWidth,
        currentDensity: densityRef.current,
        controls,
        geometry,
        minimumDensity,
      });
      if (nextDensity === densityRef.current) return;
      if (densityFolds(nextDensity) !== densityFolds(densityRef.current)) {
        onFold();
      }
      densityRef.current = nextDensity;
      setDensity(nextDensity);
    },
    [controls, geometry, minimumDensity, onFold],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const availableWidth = readMeasuredWidth(event);
      if (availableWidth === null) return;
      availableWidthRef.current = availableWidth;
      updateDensityForWidth(availableWidth);
    },
    [updateDensityForWidth],
  );

  useEffect(() => {
    if (availableWidthRef.current > 0) {
      updateDensityForWidth(availableWidthRef.current);
    }
  }, [updateDensityForWidth]);

  return { density, handleLayout };
}

interface ControlledAgentControlsProps {
  provider: string;
  workspaceId?: string | null;
  modelOptions?: AgentControlOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  thinkingOptions?: AgentControlOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  disabled?: boolean;
  isModelLoading?: boolean;
  modelSelectorProviders?: ProviderSelectorProvider[];
  agentProfiles?: AgentProfilePicker | null;
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditAgentProfile?: (profileId: string) => void;
  optionControls?: ComposerOptionControls;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  modeControl?: AgentModeControlValue | null;
  modelSelectorServerId?: string | null;
  btwAgentId?: string | null;
  isCompactLayout?: boolean;
}

export interface DraftAgentControlsProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider | null;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  effectiveModelId: string;
  onSelectModel: (modelId: string) => void;
  isModelLoading: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  isAllModelsLoading: boolean;
  /** `false` when the provider is unknown or not ready. */
  onSelectProviderAndModel: (provider: AgentProvider, modelId: string) => boolean;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  selectedThinkingOptionId: string;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  onApplyAgentProfile: DraftAgentProfileControls["applyProfile"];
  /** The controls the daemon described for the draft; absent until it answers. */
  optionControls?: ComposerOptionControls;
  /** What the draft will create with, edits included, whether or not the daemon has answered. */
  options: ProviderOptions;
  onSetOption: (key: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  disabled?: boolean;
  modelSelectorServerId?: string | null;
  isCompactLayout?: boolean;
  /** Which composer a plugin's `useComposer()` reports. */
  context?: "draft" | "new-workspace";
  /** What plugins set on the agent this draft creates. */
  metadata: Record<string, JsonValue>;
  onSetMetadata: (patch: Record<string, JsonValue>) => void;
}

interface AgentControlsProps {
  showToolbar: boolean;
  agentId: string;
  serverId: string;
  workspaceId?: string | null;
  onDropdownClose?: () => void;
  isCompactLayout?: boolean;
}

function AgentControlCommandCenterRegistration({
  sourceId,
  enabled,
  controls,
}: {
  sourceId: string;
  enabled: boolean;
  controls: AgentControlCommandCenterSource;
}) {
  const { isCommandCenterTarget } = useComposerKeyboardScope();
  useAgentControlCommandCenterActions({
    sourceId,
    enabled: enabled && isCommandCenterTarget,
    controls,
  });
  return null;
}

function findOptionLabel(
  options: AgentControlOption[] | undefined,
  selectedId: string | undefined,
  fallback: string,
) {
  if (!options || options.length === 0) {
    return fallback;
  }
  const selected = options.find((option) => option.id === selectedId);
  return selected?.label ?? fallback;
}

function toCommandCenterModes(modeControl: AgentModeControlValue | null) {
  if (!modeControl) return undefined;
  return {
    options: modeControl.modeOptions,
    selectedId: modeControl.selectedModeId,
    select: modeControl.onSelectMode,
  };
}

function getModeProviderDefinitions(modeControl: AgentModeControlValue | null) {
  return modeControl?.providerDefinitions ?? EMPTY_AGENT_PROVIDER_DEFINITIONS;
}

type ActiveSheet = "features" | null;

function resolveHasAnyControl({
  canSelectModel,
  thinkingOptions,
  controls,
  hasMode,
  pluginItemCount,
}: {
  canSelectModel: boolean;
  thinkingOptions: AgentControlOption[] | undefined;
  controls: readonly AgentOptionControl[] | undefined;
  hasMode: boolean;
  pluginItemCount: number;
}) {
  return (
    canSelectModel ||
    Boolean(thinkingOptions?.length) ||
    Boolean(controls?.length) ||
    hasMode ||
    pluginItemCount > 0
  );
}

function toThinkingControlOptions(options: AgentControlOption[] | undefined): AgentControlOption[] {
  return (options ?? []).map((option) => ({
    id: option.id,
    label: formatThinkingOptionLabel(option),
  }));
}

/**
 * The picker's edit shortcut. Agent profiles are host config, so it lands on the
 * host settings section that owns the list.
 */
function useEditAgentProfilesNavigation(
  serverId: string | null,
  isSupported: boolean,
): (() => void) | undefined {
  const handleEdit = useCallback(() => {
    if (!serverId) return;
    router.push(buildSettingsHostSectionRoute(serverId, "agent-profiles"));
  }, [serverId]);
  return serverId && isSupported ? handleEdit : undefined;
}

function resolveAgentProfileEditorActions(
  isSupported: boolean,
  editor: AgentProfileEditorControls,
): {
  create?: (seed: AgentProfileSeed) => Promise<AgentProfile | null>;
  edit?: (profileId: string) => void;
} {
  if (!isSupported) {
    return {};
  }
  return {
    create: editor.quickCreateFromModel,
    edit: editor.openEdit,
  };
}

function buildFallbackModelSelectorProviders(
  provider: string,
  modelOptions: AgentControlOption[] | undefined,
): ProviderSelectorProvider[] {
  if (!modelOptions || modelOptions.length === 0) {
    return [];
  }
  return [
    {
      id: provider,
      label: provider,
      modelSelection: {
        kind: "models",
        rows: modelOptions.map((option) => ({
          favoriteKey: `${provider}:${option.id}`,
          provider,
          providerLabel: provider,
          modelId: option.id,
          modelLabel: option.label,
        })),
      },
    },
  ];
}

function pickSheetModel({
  nextProviderId,
  modelId,
  onSelectProviderAndModel,
  onSelectModel,
}: {
  nextProviderId: string;
  modelId: string;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  onSelectModel?: (modelId: string) => void;
}) {
  if (onSelectProviderAndModel) {
    onSelectProviderAndModel(nextProviderId, modelId);
    return;
  }
  onSelectModel?.(modelId);
}

function pickDesktopModel({
  nextProviderId,
  modelId,
  currentProvider,
  onSelectModel,
  onSelectProviderAndModel,
}: {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
}) {
  if (onSelectProviderAndModel) {
    onSelectProviderAndModel(nextProviderId, modelId);
    return;
  }
  if (nextProviderId === currentProvider) {
    onSelectModel?.(modelId);
  }
}

type AgentControlsSlice = {
  provider: string;
  cwd: string | null;
  runtimeModelId: string | null;
  model: string | null | undefined;
  options: ProviderOptions | undefined;
  controls: AgentOptionControl[] | undefined;
  runtimeThinkingOptionId: string | null;
  thinkingOptionId: string | null | undefined;
  lastUsage: unknown;
  metadata: Record<string, JsonValue> | undefined;
} | null;

function selectAgentControlsSlice(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): AgentControlsSlice {
  const currentAgent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
  if (!currentAgent) {
    return null;
  }
  return {
    provider: currentAgent.provider,
    cwd: currentAgent.cwd,
    runtimeModelId: currentAgent.runtimeInfo?.model ?? null,
    model: currentAgent.model,
    options: currentAgent.options,
    controls: currentAgent.controls,
    runtimeThinkingOptionId: currentAgent.runtimeInfo?.thinkingOptionId ?? null,
    thinkingOptionId: currentAgent.thinkingOptionId,
    lastUsage: currentAgent.lastUsage,
    metadata: currentAgent.metadata,
  };
}

function resolveSnapshotModeIds(
  entry: ReturnType<typeof resolveProviderSnapshotEntry>,
): string[] | null {
  if (entry?.status !== "ready" || !entry.modes) {
    return null;
  }
  return entry.modes.map((mode) => mode.id);
}

function buildAgentProviderDefinitions(
  agentProvider: string | undefined,
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
): AgentProviderDefinition[] {
  const definition = agentProvider
    ? resolveProviderDefinition(agentProvider, snapshotEntries)
    : undefined;
  return definition ? [definition] : [];
}

function buildAgentProviderModels(
  agentProvider: string | undefined,
  models: AgentModelDefinition[] | null,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  if (agentProvider && models) {
    map.set(agentProvider, models);
  }
  return map;
}

function densityFolds(density: ComposerControlDensity): boolean {
  return resolveComposerControlPresentation(density).foldControls;
}

function ControlledAgentControls({
  provider,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
  isModelLoading = false,
  modelSelectorProviders,
  agentProfiles = null,
  onApplyAgentProfile,
  onEditAgentProfiles,
  onCreateAgentProfile,
  onEditAgentProfile,
  optionControls,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  modeControl,
  modelSelectorServerId = null,
  workspaceId = null,
  btwAgentId,
  isCompactLayout,
}: ControlledAgentControlsProps) {
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const isCompact = isCompactLayout ?? isCompactFormFactor;
  // Control sizes follow the window layout, as the toolbar's stylesheet does. A narrow pane in a
  // wide window (`isCompactLayout`) changes which labels show, never how large a control is.
  const toolbarSizing = controlSizingForLayout(isCompactFormFactor);
  const toolbarGeometry = useMemo(() => composerToolbarGeometry(toolbarSizing), [toolbarSizing]);
  const { fontScale } = useWindowDimensions();
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);
  const [openSelector, setOpenSelector] = useState<string | null>(null);
  // A compact composer always folds its controls into the model sheet; the width budget only
  // decides whether the model keeps its label.
  const minimumDensity: ComposerControlDensity = isCompact ? "compact" : "full";

  const canSelectModel = Boolean(onSelectModel);
  const canSelectThinking = Boolean(
    onSelectThinkingOption && thinkingOptions && thinkingOptions.length > 0,
  );
  const pluginItemCount = usePluginComposerItemCount(modelSelectorServerId);
  const { width: pluginItemsWidth, onLayout: handlePluginItemsLayout } = usePluginToolbarWidth();

  const formattedThinkingOptions = useMemo(
    () => toThinkingControlOptions(thinkingOptions),
    [thinkingOptions],
  );
  const displayThinking = findOptionLabel(
    formattedThinkingOptions,
    selectedThinkingOptionId,
    formattedThinkingOptions[0]?.label ?? t("agentControls.thinking.unknown"),
  );

  const hasAnyControl = resolveHasAnyControl({
    canSelectModel,
    thinkingOptions,
    controls: optionControls?.controls,
    hasMode: isSet(modeControl),
    pluginItemCount,
  });
  const featureControls = useMemo(() => toFeatureControls(optionControls), [optionControls]);
  const controlPresence = useMemo(
    () => ({
      hasModel: canSelectModel,
      hasThinking: canSelectThinking,
      hasMode: isSet(modeControl),
      features: featureControls,
      pluginItemsWidth,
      fontScale,
    }),
    [canSelectModel, canSelectThinking, featureControls, fontScale, modeControl, pluginItemsWidth],
  );
  const clearOpenOverlays = useCallback(() => {
    setOpenSelector(null);
    setActiveSheet(null);
  }, []);
  const { density, handleLayout } = useFoldedToolbarDensity({
    controls: controlPresence,
    geometry: toolbarGeometry,
    minimumDensity,
    onFold: clearOpenOverlays,
  });
  const presentation = useMemo(() => resolveComposerControlPresentation(density), [density]);
  const layoutContextValue = useMemo(
    () => ({
      glyphs: toolbarGeometry.glyphs,
      presentation,
    }),
    [presentation, toolbarGeometry],
  );

  const fallbackModelSelectorProviders = useMemo(
    () => buildFallbackModelSelectorProviders(provider, modelOptions),
    [modelOptions, provider],
  );
  const effectiveModelSelectorProviders = modelSelectorProviders ?? fallbackModelSelectorProviders;

  const thinking = useMemo(
    () =>
      toThinkingPicker({
        canSelectThinking,
        options: formattedThinkingOptions,
        selectedThinkingOptionId,
        onSelectThinkingOption,
        displayThinking,
      }),
    [
      canSelectThinking,
      displayThinking,
      formattedThinkingOptions,
      onSelectThinkingOption,
      selectedThinkingOptionId,
    ],
  );
  const effortKeys = useEffortCycleShortcut(thinking, disabled);
  const items = useAgentControlItems({
    surface: presentation.foldControls ? "sheet" : "toolbar",
    presentation,
    thinking,
    optionControls,
  });

  const handleToolbarOpenChange = useCallback(
    (id: string | null) => {
      setOpenSelector(id);
      if (id === null) onDropdownClose?.();
    },
    [onDropdownClose],
  );

  const handleDesktopModelSelect = useCallback(
    (nextProviderId: string, modelId: string) => {
      pickDesktopModel({
        nextProviderId,
        modelId,
        currentProvider: provider,
        onSelectModel,
        onSelectProviderAndModel,
      });
    },
    [onSelectModel, onSelectProviderAndModel, provider],
  );

  const handleOpenSheet = useCallback((sheet: Exclude<ActiveSheet, null>) => {
    Keyboard.dismiss();
    setActiveSheet(sheet);
  }, []);

  const handleCloseSheet = useCallback(() => {
    setActiveSheet(null);
    if (!presentation.foldControls) onDropdownClose?.();
  }, [onDropdownClose, presentation.foldControls]);

  const handleSheetModelSelect = useCallback(
    (nextProviderId: string, modelId: string) => {
      pickSheetModel({
        nextProviderId,
        modelId,
        onSelectProviderAndModel,
        onSelectModel,
      });
    },
    [onSelectModel, onSelectProviderAndModel],
  );

  if (!hasAnyControl) {
    return null;
  }

  return (
    <ComposerControlLayoutProvider value={layoutContextValue}>
      <View style={styles.container} onLayout={handleLayout} testID="agent-controls-toolbar">
        {!presentation.foldControls ? (
          <DesktopAgentControlsContent
            provider={provider}
            workspaceId={workspaceId}
            selectedModelId={selectedModelId}
            thinkingItems={items.thinking}
            effortKeys={effortKeys}
            featureItems={items.features}
            onApplyAgentProfile={onApplyAgentProfile}
            onEditAgentProfiles={onEditAgentProfiles}
            onCreateAgentProfile={onCreateAgentProfile}
            onEditAgentProfile={onEditAgentProfile}
            onDropdownClose={onDropdownClose}
            onModelSelectorOpen={onModelSelectorOpen}
            onRetryModelProvider={onRetryModelProvider}
            isRetryingModelProvider={isRetryingModelProvider}
            agentProfiles={agentProfiles}
            disabled={disabled}
            isModelLoading={isModelLoading}
            canSelectModel={canSelectModel}
            modelSelectorProviders={effectiveModelSelectorProviders}
            openSelector={openSelector}
            handleDesktopModelSelect={handleDesktopModelSelect}
            handleToolbarOpenChange={handleToolbarOpenChange}
            handleSheetOpenChange={setOpenSelector}
            modeControl={modeControl}
            presentation={presentation}
            hasPluginItems={pluginItemsWidth > 0}
            glyphs={layoutContextValue.glyphs}
            activeSheet={activeSheet}
            handleOpenSheet={handleOpenSheet}
            handleCloseSheet={handleCloseSheet}
            modelSelectorServerId={modelSelectorServerId}
            btwAgentId={btwAgentId}
          />
        ) : (
          <SheetAgentControlsContent
            provider={provider}
            workspaceId={workspaceId}
            selectedModelId={selectedModelId}
            thinkingItems={items.thinking}
            effortKeys={effortKeys}
            featureItems={items.features}
            onApplyAgentProfile={onApplyAgentProfile}
            onEditAgentProfiles={onEditAgentProfiles}
            onCreateAgentProfile={onCreateAgentProfile}
            onEditAgentProfile={onEditAgentProfile}
            onDropdownClose={onDropdownClose}
            onModelSelectorOpen={onModelSelectorOpen}
            onRetryModelProvider={onRetryModelProvider}
            isRetryingModelProvider={isRetryingModelProvider}
            agentProfiles={agentProfiles}
            disabled={disabled}
            isModelLoading={isModelLoading}
            canSelectModel={canSelectModel}
            modelSelectorProviders={effectiveModelSelectorProviders}
            openSelector={openSelector}
            displayThinking={thinking ? displayThinking : null}
            handleSheetModelSelect={handleSheetModelSelect}
            handleSheetOpenChange={setOpenSelector}
            modeControl={modeControl}
            glyphs={layoutContextValue.glyphs}
            showLabels={presentation.showModelLabel}
            modelSelectorServerId={modelSelectorServerId}
            btwAgentId={btwAgentId}
            canSwitchProvider={Boolean(onSelectProviderAndModel)}
          />
        )}
        {!isCompact ? (
          <PluginToolbarSlot
            serverId={modelSelectorServerId}
            width={pluginItemsWidth}
            fits={!presentation.aggregateFeatures}
            onLayout={handlePluginItemsLayout}
          />
        ) : null}
      </View>
    </ComposerControlLayoutProvider>
  );
}

interface AgentControlsContentProps {
  provider: string;
  workspaceId?: string | null;
  selectedModelId?: string;
  thinkingItems: ComposerControlItem[];
  effortKeys: ReturnType<typeof useShortcutKeys>;
  featureItems: ComposerControlItem[];
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditAgentProfile?: (profileId: string) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider: boolean;
  agentProfiles: AgentProfilePicker | null;
  disabled: boolean;
  isModelLoading: boolean;
  canSelectModel: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  openSelector: string | null;
  handleSheetOpenChange: (id: string | null) => void;
  modeControl?: AgentModeControlValue | null;
  glyphs: ToolbarGlyphs;
  modelSelectorServerId: string | null;
  btwAgentId?: string | null;
}

interface DesktopAgentControlsContentProps extends AgentControlsContentProps {
  handleDesktopModelSelect: (providerId: string, modelId: string) => void;
  handleToolbarOpenChange: (id: string | null) => void;
  presentation: ComposerControlPresentation;
  hasPluginItems: boolean;
  activeSheet: ActiveSheet;
  handleOpenSheet: (sheet: Exclude<ActiveSheet, null>) => void;
  handleCloseSheet: () => void;
}

function DesktopAgentControlsContent(props: DesktopAgentControlsContentProps) {
  const sheetBridge = useComposerSheetBridge();
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    provider,
    workspaceId,
    selectedModelId,
    thinkingItems,
    effortKeys,
    featureItems,
    onApplyAgentProfile,
    onEditAgentProfiles,
    onCreateAgentProfile,
    onEditAgentProfile,
    onDropdownClose,
    onModelSelectorOpen,
    onRetryModelProvider,
    isRetryingModelProvider,
    agentProfiles,
    disabled,
    isModelLoading,
    canSelectModel,
    modelSelectorProviders,
    openSelector,
    handleDesktopModelSelect,
    handleToolbarOpenChange,
    handleSheetOpenChange,
    modeControl,
    presentation,
    hasPluginItems,
    glyphs,
    activeSheet,
    handleOpenSheet,
    handleCloseSheet,
    modelSelectorServerId,
    btwAgentId,
  } = props;
  const { action: toggleAction, keys: modelKeys } = useModelPickerShortcut(disabled);
  const handleOpenBtwPanel = useOpenBtwPanel(modelSelectorServerId, btwAgentId, workspaceId);
  const modelTooltipLabel = t(getAgentControlHintKey("model"));
  const modelToolbar = useMemo(
    () => ({
      glyph: glyphs.label,
      showCaret: presentation.showCarets,
      tooltip: <ControlTooltipHint label={modelTooltipLabel} shortcutKeys={modelKeys} />,
    }),
    [glyphs.label, presentation.showCarets, modelTooltipLabel, modelKeys],
  );
  const featuresSheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("agentControls.features.title") }),
    [t],
  );
  const handleOpenFeatures = useCallback(() => handleOpenSheet("features"), [handleOpenSheet]);
  const hasFeatures = featureItems.length > 0 || hasPluginItems;
  return (
    <>
      {canSelectModel ? (
        <View style={styles.modelControl}>
          <CombinedModelSelector
            providers={modelSelectorProviders}
            selectedProvider={provider}
            selectedModel={selectedModelId ?? ""}
            onSelect={handleDesktopModelSelect}
            profiles={agentProfiles}
            onApplyProfile={onApplyAgentProfile}
            onEditProfiles={onEditAgentProfiles}
            onCreateProfile={onCreateAgentProfile}
            onEditProfile={onEditAgentProfile}
            isLoading={isModelLoading}
            disabled={disabled}
            toggleAction={toggleAction}
            onOpen={onModelSelectorOpen}
            onClose={onDropdownClose}
            onRetryProvider={onRetryModelProvider}
            isRetryingProvider={isRetryingModelProvider}
            serverId={modelSelectorServerId}
            desktopPlacement="top-start"
            desktopMinWidth={360}
            toolbar={modelToolbar}
          />
        </View>
      ) : null}

      <ComposerControls
        items={thinkingItems}
        shortcutKeys={effortKeys}
        surface="toolbar"
        disabled={disabled}
        openId={openSelector}
        onOpenIdChange={handleToolbarOpenChange}
      />

      {modeControl ? <AgentModeControl {...modeControl} onClose={onDropdownClose} /> : null}

      {btwAgentId && modelSelectorServerId ? (
        <AgentControlTrigger
          icon={MessageCircleQuestionMark}
          surface="toolbar"
          label={t("agentControls.btw.title")}
          showToolbarLabel={false}
          showCaret={false}
          disabled={disabled}
          onPress={handleOpenBtwPanel}
          accessibilityLabel={t("agentControls.btw.open")}
          testID="agent-btw-control"
        />
      ) : null}

      {presentation.aggregateFeatures && hasFeatures ? (
        <>
          <Pressable
            onPress={handleOpenFeatures}
            disabled={disabled}
            style={styles.modeIconBadge}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.features.open")}
            testID="agent-controls-features"
          >
            <ComposerToolbarGlyph role="icon">
              <Settings2
                size={glyphs.icon.size}
                strokeWidth={glyphs.icon.strokeWidth}
                color={toolbarGlyphColor(theme, glyphs.icon.tone)}
              />
            </ComposerToolbarGlyph>
          </Pressable>
          <AdaptiveModalSheet
            header={featuresSheetHeader}
            visible={activeSheet === "features"}
            onClose={handleCloseSheet}
            contextBridge={sheetBridge}
            testID="agent-features-sheet"
          >
            <ComposerControls
              items={featureItems}
              surface="sheet"
              disabled={disabled}
              openId={openSelector}
              onOpenIdChange={handleSheetOpenChange}
            />
            <PluginComposerItems serverId={modelSelectorServerId} surface="sheet" />
          </AdaptiveModalSheet>
        </>
      ) : (
        <ComposerControls
          items={featureItems}
          surface="toolbar"
          disabled={disabled}
          openId={openSelector}
          onOpenIdChange={handleToolbarOpenChange}
          onActionComplete={onDropdownClose}
        />
      )}
    </>
  );
}

interface SheetAgentControlsContentProps extends AgentControlsContentProps {
  showLabels: boolean;
  displayThinking: string | null;
  handleSheetModelSelect: (providerId: string, modelId: string) => void;
  canSwitchProvider: boolean;
}

function SheetAgentControlsContent(props: SheetAgentControlsContentProps) {
  const { t } = useTranslation();
  const sheetBridge = useComposerSheetBridge();
  const {
    provider,
    workspaceId,
    selectedModelId,
    thinkingItems,
    effortKeys,
    featureItems,
    onApplyAgentProfile,
    onEditAgentProfiles,
    onCreateAgentProfile,
    onEditAgentProfile,
    onDropdownClose,
    onModelSelectorOpen,
    onRetryModelProvider,
    isRetryingModelProvider,
    agentProfiles,
    disabled,
    isModelLoading,
    canSelectModel,
    modelSelectorProviders,
    openSelector,
    displayThinking,
    handleSheetModelSelect,
    handleSheetOpenChange,
    modeControl,
    glyphs,
    showLabels,
    modelSelectorServerId,
    btwAgentId,
    canSwitchProvider,
  } = props;
  const handleOpenBtwPanel = useOpenBtwPanel(modelSelectorServerId, btwAgentId, workspaceId);

  const sheetControls = (
    <View style={styles.combinedSheetControls} testID="agent-controls-combined-sheet-controls">
      <ComposerControls
        items={thinkingItems}
        surface="sheet"
        disabled={disabled}
        openId={openSelector}
        onOpenIdChange={handleSheetOpenChange}
      />

      {modeControl ? <AgentModeControl {...modeControl} surface="sheet" /> : null}

      {btwAgentId && modelSelectorServerId ? (
        <AgentControlTrigger
          icon={MessageCircleQuestionMark}
          surface="sheet"
          label={t("agentControls.btw.title")}
          showToolbarLabel={false}
          showCaret={false}
          disabled={disabled}
          onPress={handleOpenBtwPanel}
          accessibilityLabel={t("agentControls.btw.open")}
          testID="agent-btw-control"
        />
      ) : null}

      <ComposerControls
        items={featureItems}
        surface="sheet"
        disabled={disabled}
        openId={openSelector}
        onOpenIdChange={handleSheetOpenChange}
      />
      <PluginComposerItems serverId={modelSelectorServerId} surface="sheet" />
    </View>
  );

  return canSelectModel ? (
    <CompactModelSheet
      providers={modelSelectorProviders}
      selectedProvider={provider}
      selectedModel={selectedModelId ?? ""}
      thinkingLabel={displayThinking}
      effortKeys={effortKeys}
      onSelect={handleSheetModelSelect}
      profiles={agentProfiles}
      onApplyProfile={onApplyAgentProfile}
      onEditProfiles={onEditAgentProfiles}
      onCreateProfile={onCreateAgentProfile}
      onEditProfile={onEditAgentProfile}
      contextBridge={sheetBridge}
      isLoading={isModelLoading}
      disabled={disabled}
      onOpen={onModelSelectorOpen}
      onClose={onDropdownClose}
      onRetryProvider={onRetryModelProvider}
      isRetryingProvider={isRetryingModelProvider}
      serverId={modelSelectorServerId}
      glyphs={glyphs}
      showLabels={showLabels}
      canSwitchProvider={canSwitchProvider}
    >
      {sheetControls}
    </CompactModelSheet>
  ) : null;
}

function useAgentOptionControls(
  agent: { controls?: AgentOptionControl[]; options?: ProviderOptions } | null | undefined,
  onSetOption: ComposerOptionControls["onSetOption"],
): ComposerOptionControls {
  const controls = agent?.controls;
  const options = agent?.options;
  return useMemo(
    () => ({ controls: controls ?? [], options: options ?? EMPTY_OPTIONS, onSetOption }),
    [controls, onSetOption, options],
  );
}

export const AgentControls = memo(function AgentControls({
  showToolbar,
  agentId,
  serverId,
  workspaceId,
  onDropdownClose,
  isCompactLayout,
}: AgentControlsProps) {
  const { updatePreferences } = useFormPreferences();
  const agent = useSessionStore(
    useShallow((state) => selectAgentControlsSlice(state, serverId, agentId)),
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();
  const modeControl = useLiveAgentModeControl(serverId, agentId);
  const commandCenterModes = toCommandCenterModes(modeControl);
  const modeProviderDefinitions = getModeProviderDefinitions(modeControl);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isRefreshing: snapshotIsRefreshing,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId, { cwd: agent?.cwd });

  const snapshotSelectedEntry = useMemo(
    () => resolveProviderSnapshotEntry(snapshotEntries, agent?.provider),
    [snapshotEntries, agent?.provider],
  );

  const models = filterSelectableModels(snapshotSelectedEntry?.models ?? null);
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";

  const agentProviderDefinitions = useMemo(
    () => buildAgentProviderDefinitions(agent?.provider, snapshotEntries),
    [agent?.provider, snapshotEntries],
  );

  const agentProviderModels = useMemo(
    () => buildAgentProviderModels(agent?.provider, models),
    [agent?.provider, models],
  );
  const agentModelSelectorProviders = useMemo(() => {
    if (snapshotSelectedEntry) {
      return [buildSelectorProvider(snapshotSelectedEntry)];
    }
    return buildProviderSelectorProviders({
      providerDefinitions: agentProviderDefinitions,
      modelsByProvider: agentProviderModels,
    });
  }, [agentProviderDefinitions, agentProviderModels, snapshotSelectedEntry]);

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    runtimeThinkingOptionId: agent?.runtimeThinkingOptionId,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  });

  const modelOptions = useMemo<AgentControlOption[]>(() => {
    return (models ?? []).map((model) => ({ id: model.id, label: model.label }));
  }, [models]);

  const thinkingOptions = useMemo<AgentControlOption[]>(() => {
    return (modelSelection.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      label: formatThinkingOptionLabel(option),
    }));
  }, [modelSelection.thinkingOptions]);

  const agentProvider = agent?.provider;
  const activeModelId = modelSelection.activeModelId;

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      try {
        await client.setAgentModel(agentId, modelId);
        await updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: { model: modelId },
          }),
        );
      } catch (error) {
        console.warn("[AgentControls] setAgentModel or persist preference failed", error);
        toast.error(toErrorMessage(error));
      }
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );
  const handleSelectCommandCenterModel = useCallback(
    (_provider: AgentProvider, modelId: string) => handleSelectModel(modelId),
    [handleSelectModel],
  );

  // A running agent is one provider's process, so only that provider's profiles
  // can apply to it.
  const profileProviders = useMemo(() => (agentProvider ? [agentProvider] : []), [agentProvider]);
  const profileModeIds = useMemo(
    () => resolveSnapshotModeIds(snapshotSelectedEntry),
    [snapshotSelectedEntry],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({ kind: "agent", agentId, availableModeIds: profileModeIds }),
    [agentId, profileModeIds],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(serverId, agentProfiles !== null);
  const profileEditor = useAgentProfileEditor(serverId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const handleSelectThinkingOption = useCallback(
    (thinkingOptionId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      if (activeModelId) {
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              model: activeModelId,
              thinkingByModel: {
                [activeModelId]: thinkingOptionId,
              },
            },
          }),
        ).catch((error) => {
          console.warn("[AgentControls] persist thinking preference failed", error);
        });
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[AgentControls] setAgentThinkingOption failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [activeModelId, agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleSetOption = useCallback(
    (key: string, value: unknown) => {
      if (!client || !agentProvider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider: agentProvider,
          updates: {
            options: {
              [key]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[AgentControls] persist option preference failed", error);
      });
      void client.setAgentOptions(agentId, { [key]: value }).catch((error) => {
        console.warn("[AgentControls] setAgentOptions failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );

  const agentOptionControls = useAgentOptionControls(agent, handleSetOption);

  // The agent's composer exists apart from this component; while this is mounted, prompt
  // commands go through the input the user is typing in.
  const composer = useMemo(() => agentComposer(serverId, agentId), [agentId, serverId]);
  const composerInput = useComposerInput();
  useEffect(
    () =>
      composerInput
        ? composer.attachInput({
            isLive: composerInput.isLive,
            setText: composerInput.setText,
            insertText: composerInput.insertText,
            isRevealed: composerInput.isRevealed,
            focus: composerInput.focus,
          })
        : undefined,
    [composer, composerInput],
  );

  const commandCenterControls = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId,
      ownerKey: agentId,
      provider: agentProvider,
      providerDefinitions: modeProviderDefinitions,
      profiles: agentProfiles,
      models: {
        providers: agentModelSelectorProviders,
        selectedProvider: agentProvider,
        selectedModelId: activeModelId,
        select: handleSelectCommandCenterModel,
      },
      thinking: {
        options: modelSelection.thinkingOptions,
        selectedId: modelSelection.selectedThinkingId,
        select: handleSelectThinkingOption,
      },
      modes: commandCenterModes,
      optionControls: client ? agentOptionControls : null,
    }),
    [
      activeModelId,
      agentOptionControls,
      agentProfiles,
      client,
      agentId,
      agentModelSelectorProviders,
      agentProvider,
      commandCenterModes,
      handleSelectCommandCenterModel,
      handleSelectThinkingOption,
      modeProviderDefinitions,
      modelSelection.selectedThinkingId,
      modelSelection.thinkingOptions,
      serverId,
    ],
  );

  const commandCenterRegistration = (
    <AgentControlCommandCenterRegistration
      sourceId={`agent:${serverId}:${agentId}`}
      enabled={Boolean(client)}
      controls={commandCenterControls}
    />
  );

  const handleModelSelectorOpen = useCallback(() => {
    refetchSnapshotIfStale(agentProvider);
  }, [agentProvider, refetchSnapshotIfStale]);

  const handleRetryModelProvider = useCallback(
    (provider: AgentProvider) => {
      void refreshSnapshot([provider]);
    },
    [refreshSnapshot],
  );

  if (!agent) {
    return null;
  }

  return (
    <ComposerModelProvider value={composer}>
      {commandCenterRegistration}
      {showToolbar ? (
        <>
          {profileEditor.element}
          <ControlledAgentControls
            provider={agent.provider}
            workspaceId={workspaceId}
            modelSelectorProviders={agentModelSelectorProviders}
            modelOptions={modelOptions}
            selectedModelId={modelSelection.activeModelId ?? undefined}
            onSelectModel={handleSelectModel}
            agentProfiles={agentProfiles}
            onApplyAgentProfile={agentProfiles?.applyProfile}
            onEditAgentProfiles={handleEditAgentProfiles}
            onCreateAgentProfile={profileActions.create}
            onEditAgentProfile={profileActions.edit}
            thinkingOptions={thinkingOptions.length > 0 ? thinkingOptions : undefined}
            selectedThinkingOptionId={modelSelection.selectedThinkingId ?? undefined}
            onSelectThinkingOption={handleSelectThinkingOption}
            optionControls={agentOptionControls}
            isModelLoading={snapshotIsLoading || selectedProviderIsLoading}
            onModelSelectorOpen={handleModelSelectorOpen}
            onRetryModelProvider={handleRetryModelProvider}
            isRetryingModelProvider={snapshotIsRefreshing}
            onDropdownClose={onDropdownClose}
            disabled={!client}
            modeControl={modeControl}
            modelSelectorServerId={serverId}
            btwAgentId={agentId}
            isCompactLayout={isCompactLayout}
          />
        </>
      ) : null}
    </ComposerModelProvider>
  );
});

export function DraftAgentControls({
  showToolbar,
  draftId,
  serverId,
  providerDefinitions,
  selectedProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  effectiveModelId,
  onSelectModel,
  isModelLoading: _isModelLoading,
  modelSelectorProviders,
  isAllModelsLoading,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  onApplyAgentProfile,
  optionControls,
  options,
  onSetOption,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  disabled = false,
  modelSelectorServerId = null,
  isCompactLayout,
  context = "draft",
  metadata,
  onSetMetadata,
}: DraftAgentControlsProps & { draftId: string; serverId: string; showToolbar: boolean }) {
  const mappedThinkingOptions = useMemo<AgentControlOption[]>(() => {
    return toThinkingControlOptions(thinkingOptions);
  }, [thinkingOptions]);

  const effectiveSelectedThinkingOption = selectedThinkingOptionId || mappedThinkingOptions[0]?.id;

  const modelOptions = useMemo<AgentControlOption[]>(
    () =>
      models.map((model) => ({
        id: model.id,
        label: model.label,
      })),
    [models],
  );

  // The draft form is the one surface that can switch provider, so every profile
  // the host can actually run is offered here.
  const profileProviders = useMemo(
    () => modelSelectorProviders.map((entry) => entry.id),
    [modelSelectorProviders],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({
      kind: "draft",
      controls: {
        applyProfile: onApplyAgentProfile,
      },
    }),
    [onApplyAgentProfile],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId: modelSelectorServerId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(
    modelSelectorServerId,
    agentProfiles !== null,
  );
  const profileEditor = useAgentProfileEditor(modelSelectorServerId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const modeControl = useMemo<AgentModeControlValue | null>(
    () =>
      selectedProvider && modeOptions.length > 0
        ? {
            provider: selectedProvider,
            providerDefinitions,
            modeOptions,
            selectedModeId: selectedMode,
            onSelectMode,
            disabled,
          }
        : null,
    [selectedProvider, providerDefinitions, modeOptions, selectedMode, onSelectMode, disabled],
  );

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const isLocked = useCallback(() => disabledRef.current, []);
  const composerAgent = useMemo(
    () =>
      draftComposerAgent({
        context,
        disabled,
        isLocked,
        selectedProvider,
        selectedModel,
        selectedMode,
        thinking: effectiveSelectedThinkingOption ?? null,
        options,
        metadata,
        onSelectProviderAndModel,
        onSelectModel,
        onSelectMode,
        onSelectThinkingOption,
        onSetOption,
        onSetMetadata,
      }),
    [
      context,
      disabled,
      isLocked,
      effectiveSelectedThinkingOption,
      metadata,
      onSelectMode,
      onSelectModel,
      onSelectProviderAndModel,
      onSelectThinkingOption,
      onSetMetadata,
      onSetOption,
      options,
      selectedMode,
      selectedModel,
      selectedProvider,
    ],
  );

  const composerInput = useComposerInput();
  const composerModel = useMemo(
    () =>
      composerInput
        ? composerModelFromHalves({ agent: composerAgent, input: composerInput })
        : null,
    [composerAgent, composerInput],
  );

  const commandCenterControls = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId,
      ownerKey: draftId,
      provider: selectedProvider,
      providerDefinitions,
      profiles: agentProfiles,
      models: {
        providers: modelSelectorProviders,
        selectedProvider,
        selectedModelId: effectiveModelId,
        select: (provider, modelId) => {
          onSelectProviderAndModel(provider, modelId);
        },
      },
      thinking: {
        options: thinkingOptions,
        selectedId: selectedThinkingOptionId,
        select: onSelectThinkingOption,
      },
      modes: toCommandCenterModes(modeControl),
      optionControls: optionControls ?? null,
    }),
    [
      serverId,
      draftId,
      selectedProvider,
      providerDefinitions,
      agentProfiles,
      modelSelectorProviders,
      effectiveModelId,
      onSelectProviderAndModel,
      thinkingOptions,
      selectedThinkingOptionId,
      onSelectThinkingOption,
      modeControl,
      optionControls,
    ],
  );

  return (
    <ComposerAgentProvider value={composerAgent}>
      <ComposerModelProvider value={composerModel}>
        <AgentControlCommandCenterRegistration
          sourceId={`draft:${serverId}:${draftId}`}
          enabled={!disabled}
          controls={commandCenterControls}
        />
        {showToolbar ? (
          <>
            {profileEditor.element}
            <ControlledAgentControls
              provider={selectedProvider ?? ""}
              modelSelectorProviders={modelSelectorProviders}
              modelOptions={modelOptions}
              selectedModelId={selectedModel}
              onSelectModel={onSelectModel}
              onSelectProviderAndModel={onSelectProviderAndModel}
              isModelLoading={isAllModelsLoading}
              agentProfiles={agentProfiles}
              onApplyAgentProfile={agentProfiles?.applyProfile}
              onEditAgentProfiles={handleEditAgentProfiles}
              onCreateAgentProfile={profileActions.create}
              onEditAgentProfile={profileActions.edit}
              thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
              selectedThinkingOptionId={effectiveSelectedThinkingOption}
              onSelectThinkingOption={onSelectThinkingOption}
              optionControls={optionControls}
              onDropdownClose={onDropdownClose}
              onModelSelectorOpen={onModelSelectorOpen}
              onRetryModelProvider={onRetryModelProvider}
              isRetryingModelProvider={isRetryingModelProvider}
              disabled={disabled}
              modeControl={modeControl}
              modelSelectorServerId={modelSelectorServerId}
              isCompactLayout={isCompactLayout}
            />
          </>
        ) : null}
      </ComposerModelProvider>
    </ComposerAgentProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: TOOLBAR_CONTROL_GAP,
    // Clips pickers that run out of room.
    overflow: "hidden",
  },
  modelControl: {
    minWidth: 0,
    flexShrink: 1,
  },
  modeIconBadge: {
    ...toolbarSlot(),
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 0,
    flexShrink: 0,
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.full,
  },
  combinedSheetControls: {
    gap: theme.spacing[1],
  },
}));
