import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ConsoleApiError,
  discoverConnectionModels,
  fetchModelMetadata,
  updateAgentConfiguration,
  updateModelOverride,
} from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { FormDialog } from "../../components/ui/form-dialog.js";
import { Field, Input } from "../../components/ui/field.js";
import type { ConfigurationSnapshot } from "../../types.js";
import {
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  MODALITY_OPTIONS,
  buildModelOverride,
  draftFromOverride,
  emptyModelOverrideDraft,
  type ModelOverrideDraft,
} from "./model-override-form.js";
import { discoveryLabel, filterModels, mergeModels } from "./provider-model-data.js";
// 候选路线纯操作复用 Agent 编辑器的 model-route-editor，保持 set_model_route 值语义单一来源。
import { addCandidate, normalizeCandidates } from "./model-route-editor.js";

const MODEL_FILTERS = [
  ["all", "全部状态"],
  ["enabled", "本地启用"],
  ["disabled", "本地禁用"],
  ["active", "Active"],
  ["beta", "Beta"],
  ["deprecated", "Deprecated"],
] as const;

const PROVENANCE_LABELS: Record<string, string> = { catalog: "目录", official_patch: "官方补丁", local_override: "本地覆盖" };

type ModelManagerDialogProps = {
  snapshot: ConfigurationSnapshot;
  /** 目标 Connection ID。 */
  connection: string;
  /** 停用 Connection 仍可管理本地元数据；获取模型与加入 Route 仅在启用时可用。 */
  enabled: boolean;
  /** 测试 / 发现使用的 revision：内置连接用 runtime revision，自定义连接用 agent revision。 */
  discoveryRevision: string;
  onClose: () => void;
};

/** Connection 模型管理器：发现、本地 metadata/目录合并展示、启停与加入 Route。
 * 模型与价格仅供参考：Advertised 为声明，Verified 能力未知，获取成功不等于真实调用成功。 */
export function ModelManagerDialog({ snapshot, connection, enabled, discoveryRevision, onClose }: ModelManagerDialogProps) {
  const queryClient = useQueryClient();
  const metadataQuery = useQuery({
    queryKey: ["provider-model-metadata", connection],
    queryFn: () => fetchModelMetadata(connection),
    staleTime: 0,
  });
  const [discovery, setDiscovery] = useState<Record<string, unknown> | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [visibleLimit, setVisibleLimit] = useState(50);
  const [draft, setDraft] = useState<ModelOverrideDraft | null>(null);
  const [draftRevision, setDraftRevision] = useState("missing");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const metadata = metadataQuery.data ?? {};
  const rows = useMemo(() => mergeModels(discovery, metadata), [discovery, metadata]);
  const visibleRows = useMemo(() => filterModels(rows, search, statusFilter), [rows, search, statusFilter]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["configuration"] });
    void queryClient.invalidateQueries({ queryKey: ["provider-model-metadata", connection] });
  };

  const discoveryMutation = useMutation({
    mutationFn: () => discoverConnectionModels(connection, discoveryRevision),
    onSuccess: (result) => {
      setDiscovery(result);
      setStatus(discoveryLabel(result));
    },
    onError: (cause) => {
      setDiscovery({ state: "failed", category: cause instanceof Error ? cause.message : "获取失败" });
      setStatus(discoveryLabel({ state: "failed", category: cause instanceof Error ? cause.message : "获取失败" }));
    },
  });

  const overrideMutation = useMutation({
    mutationFn: ({ expectedRevision, model }: { expectedRevision: string; model: unknown }) =>
      updateModelOverride(connection, expectedRevision, model),
    onSuccess: () => {
      invalidate();
      setStatus("本地模型已保存；重启后生效。");
      setError("");
    },
    onError: (cause) => setError(overrideErrorMessage(cause)),
  });

  const routeMutation = useMutation({
    mutationFn: ({ revision, changes }: { revision: string; changes: unknown[] }) => updateAgentConfiguration(revision, changes),
    onSuccess: (_data, variables) => {
      invalidate();
      const name = typeof variables.changes[0] === "object" && variables.changes[0] !== null
        ? (variables.changes[0] as Record<string, unknown>).name
        : undefined;
      setStatus(`已加入 Route ${String(name ?? "")}；重启后生效。`);
      setError("");
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "加入 Route 失败"),
  });

  const modelRoutes = useMemo(() => {
    const saved = snapshot.agent?.savedValue;
    const routes = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>).model_routes : undefined;
    return typeof routes === "object" && routes !== null && !Array.isArray(routes) ? Object.keys(routes) : [];
  }, [snapshot]);

  const editable = snapshot.agent?.editable === true;
  const metadataRevision = typeof metadata.revision === "string" ? metadata.revision : "missing";
  const catalogSource = typeof metadata.catalog_source === "object" && metadata.catalog_source !== null
    ? metadata.catalog_source as Record<string, unknown>
    : {};

  const saveOverride = (model: Record<string, unknown>, expectedRevision: string) => {
    overrideMutation.mutate({ expectedRevision, model });
  };

  const joinRoute = (modelId: string, routeName: string) => {
    // 现有 Route 语法以逗号分隔候选；携带逗号的模型 ID 无法安全加入。
    if (modelId.includes(",")) {
      setError("该模型 ID 含有路线分隔符，无法按现有语法加入 Route");
      return;
    }
    const routesValue = snapshot.agent?.savedValue;
    const routesTable = typeof routesValue === "object" && routesValue !== null
      ? (routesValue as Record<string, unknown>).model_routes
      : undefined;
    const route = typeof routesTable === "object" && routesTable !== null && !Array.isArray(routesTable)
      ? (routesTable as Record<string, unknown>)[routeName]
      : undefined;
    const candidatesRaw = typeof route === "object" && route !== null && Array.isArray((route as Record<string, unknown>).candidates)
      ? (route as Record<string, unknown>).candidates as unknown[]
      : [];
    const current = normalizeCandidates(candidatesRaw.map((value) => (typeof value === "string" ? value : "")));
    const result = addCandidate(current, `${connection.toLowerCase()}:${modelId}`);
    if (result.error) {
      setError(result.error);
      return;
    }
    routeMutation.mutate({
      revision: snapshot.agent!.revision,
      changes: [{ action: "set_model_route", name: routeName, candidates: result.list }],
    });
  };

  const closeEditor = () => setDraft(null);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${connection} · 管理模型`}
      description="模型与价格仅供参考。Advertised 为声明；Verified 能力未知，获取模型成功不等于真实调用或能力验证。保存后重启生效。"
      footer={
        <p aria-live="polite" role={error ? "alert" : "status"} className={`m-0 text-xs font-semibold ${error ? "text-error" : "text-muted"}`}>
          {error || status || (metadataQuery.isPending ? "正在读取本地模型与目录…" : "模型信息已加载")}
        </p>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={!enabled || discoveryMutation.isPending} onClick={() => discoveryMutation.mutate()}>
          {discoveryMutation.isPending ? "正在获取…" : "获取模型"}
        </Button>
        <Button variant="secondary" disabled={metadataQuery.isPending} onClick={() => void metadataQuery.refetch()}>
          刷新模型信息
        </Button>
        <p role="status" className="m-0 text-xs text-muted">{discovery ? discoveryLabel(discovery) : "尚未获取模型（unknown）"}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-48">
          <Field label="搜索 model id / display name" id="model-manager-search">
            {(props) => (
              <Input
                {...props}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setVisibleLimit(50);
                }}
              />
            )}
          </Field>
        </div>
        <Field label="模型状态筛选" id="model-manager-filter">
          {(props) => (
            <select
              {...props}
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setVisibleLimit(50);
              }}
              className="border border-line bg-input px-3 py-2 text-sm text-ink outline-none"
            >
              {MODEL_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {metadataQuery.isError ? (
        <p role="alert" className="m-0 text-sm font-semibold text-error">
          {metadataQuery.error instanceof Error ? metadataQuery.error.message : "模型信息读取失败"}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {visibleRows.length === 0 && !metadataQuery.isPending ? (
          <p className="m-0 text-sm text-muted">当前没有匹配的展示条目；Connection 获取状态见上方。</p>
        ) : null}
        {visibleRows.length > visibleLimit ? (
          <p className="m-0 text-xs text-muted">当前显示 {visibleLimit} / {visibleRows.length} 条，可搜索缩小范围。</p>
        ) : null}
        {visibleRows.slice(0, visibleLimit).map((row) => (
          <ModelRow
            key={row.id}
            row={row}
            catalogSource={catalogSource}
            editable={editable}
            enabled={enabled}
            routes={modelRoutes}
            busy={overrideMutation.isPending || routeMutation.isPending}
            onEdit={() => {
              setDraftRevision(metadataRevision);
              setDraft(draftFromOverride(row.id, row.override));
            }}
            onToggleEnabled={() => {
              saveOverride(
                { ...row.override, provider: metadata.provider, id: row.id, enabled: row.metadata.enabled === false },
                metadataRevision,
              );
            }}
            onJoinRoute={(routeName) => joinRoute(row.id, routeName)}
          />
        ))}
        {visibleRows.length > visibleLimit ? (
          <Button variant="secondary" className="self-start" onClick={() => setVisibleLimit((limit) => limit + 50)}>
            显示更多模型
          </Button>
        ) : null}
      </div>

      {draft ? (
        <ModelOverrideEditor
          draft={draft}
          revision={draftRevision}
          disabled={!editable || !metadataQuery.isSuccess}
          busy={overrideMutation.isPending}
          onChange={setDraft}
          onCancel={closeEditor}
          onSave={() => {
            if (!metadataQuery.isSuccess) {
              setError("模型信息尚未加载成功");
              return;
            }
            try {
              const model = buildModelOverride(draft);
              saveOverride({ ...model, provider: metadata.provider }, draftRevision);
              closeEditor();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "模型信息无效");
            }
          }}
        />
      ) : null}
    </FormDialog>
  );
}

type ModelRowProps = {
  row: ReturnType<typeof mergeModels>[number];
  catalogSource: Record<string, unknown>;
  editable: boolean;
  enabled: boolean;
  routes: string[];
  busy: boolean;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onJoinRoute: (route: string) => void;
};

function ModelRow({ row, catalogSource, editable, enabled, routes, busy, onEdit, onToggleEnabled, onJoinRoute }: ModelRowProps) {
  const [selectedRoute, setSelectedRoute] = useState(routes[0] ?? "");
  const status = typeof row.metadata.status === "string" ? row.metadata.status : "unknown";
  const displayName = typeof row.metadata.display_name === "string" ? row.metadata.display_name : "";
  const contextWindow = row.metadata.context_window ?? "unknown";
  const maxOutput = row.metadata.max_output_tokens ?? "unknown";
  return (
    <article className="border border-line bg-glass-muted p-3">
      <h4 className="m-0 text-sm font-bold">{displayName || row.id}</h4>
      <p className="m-0 mt-1 text-xs text-muted">模型 ID：{row.id}</p>
      <p className="m-0 text-xs text-muted">
        来源：{row.sources.join(" / ")} · {row.metadata.enabled === false ? "本地禁用" : "本地启用"} · Status：{status}
      </p>
      <p className="m-0 text-xs text-muted">Context window：{String(contextWindow)} · Max output：{String(maxOutput)}</p>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs font-semibold">模型信息 / Advertised / Provenance</summary>
        <ModelDetails metadata={row.metadata} catalogSource={catalogSource} />
      </details>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onEdit}>编辑模型信息</Button>
        <Button variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy || !editable} onClick={onToggleEnabled}>
          {row.metadata.enabled === false ? "启用模型" : "禁用模型"}
        </Button>
        {routes.length > 0 ? (
          <>
            <select
              aria-label={`为 ${row.id} 选择 Route`}
              value={selectedRoute}
              onChange={(event) => setSelectedRoute(event.target.value)}
              className="border border-line bg-input px-2 py-1 text-xs text-ink outline-none"
            >
              {routes.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              className="px-2.5 py-1 text-xs"
              // 停用 Connection 或本地禁用的模型不允许进入候选链。
              disabled={!enabled || row.metadata.enabled === false || !editable || routes.length === 0 || busy}
              onClick={() => onJoinRoute(selectedRoute)}
            >
              加入 Route
            </Button>
          </>
        ) : null}
      </div>
    </article>
  );
}

function ModelDetails({ metadata, catalogSource }: { metadata: Record<string, unknown>; catalogSource: Record<string, unknown> }) {
  const recordOf = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const modalities = recordOf(metadata.modalities);
  const price = recordOf(metadata.price);
  const capabilities = recordOf(metadata.capabilities);
  const provenance = recordOf(metadata.provenance);
  const arrayText = (value: unknown) => (Array.isArray(value) ? value.map(String).join("、") : "");
  const row = (label: string, value: unknown, origin: unknown) => (
    <p className="m-0 text-xs text-muted">
      {label}：{value === null || value === undefined || value === "" ? "未知" : String(value)}
      {typeof origin === "string" ? ` · 来源：${PROVENANCE_LABELS[origin] ?? origin}` : ""}
    </p>
  );
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {row("显示名称", metadata.display_name, provenance.display_name)}
      {row("上下文窗口", metadata.context_window, provenance.context_window)}
      {row("最大输出", metadata.max_output_tokens, provenance.max_output_tokens)}
      {row("状态", metadata.status, provenance.status)}
      {row("输入模态", arrayText(modalities.input) || "未知", provenance.modalities)}
      {row("输出模态", arrayText(modalities.output) || "未知", provenance.modalities)}
      {row("输入价格（美元 / 百万 token）", price.input_per_million_usd, provenance.price)}
      {row("输出价格（美元 / 百万 token）", price.output_per_million_usd, provenance.price)}
      {CAPABILITY_KEYS.map((key) => {
        const claim = recordOf(capabilities[key]).advertised;
        return (
          <span key={key} className="contents">
            {row(`${CAPABILITY_LABELS[key]} · 声明能力（Advertised）`, claim === true ? "声明支持" : claim === false ? "未声明支持" : "未知", recordOf(provenance.capabilities)[key])}
            {row(`${CAPABILITY_LABELS[key]} · 已验证能力（Verified）`, "未知", null)}
          </span>
        );
      })}
      {Object.keys(catalogSource).length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-semibold">目录出处</summary>
          <div className="mt-1 flex flex-col gap-0.5">
            {(Object.entries(CATALOG_SOURCE_LABELS) as Array<[string, string]>).map(([key, label]) => (
              <p key={key} className="m-0 text-xs text-muted">{label}：{catalogSource[key] == null ? "未知" : String(catalogSource[key])}</p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

const CATALOG_SOURCE_LABELS: Record<string, string> = {
  name: "数据源",
  source_url: "上游地址",
  source_version: "版本",
  fetched_at: "快照时间",
  upstream_license: "许可",
  source_hash: "校验摘要",
  converter_version: "转换版本",
};

type ModelOverrideEditorProps = {
  draft: ModelOverrideDraft;
  revision: string;
  disabled: boolean;
  busy: boolean;
  onChange: (draft: ModelOverrideDraft) => void;
  onCancel: () => void;
  onSave: () => void;
};

/** 本地新增 / 编辑模型表单；字段留空表示继承目录或保持未知。 */
function ModelOverrideEditor({ draft, revision, disabled, busy, onChange, onCancel, onSave }: ModelOverrideEditorProps) {
  const patch = (values: Partial<ModelOverrideDraft>) => onChange({ ...draft, ...values });
  const toggleModality = (direction: "inputModalities" | "outputModalities", value: string) => {
    const current = draft[direction];
    patch({
      [direction]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    } as Partial<ModelOverrideDraft>);
  };
  return (
    <details open className="border border-line bg-surface p-3">
      <summary className="cursor-pointer text-sm font-bold">本地新增 / 编辑模型</summary>
      <p className="m-0 mt-1 text-xs text-muted">留空或选择“继承”会使用目录信息。没有目录信息时保持未知。能力声明仅用于展示。</p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="模型 ID" id="model-override-id" hint={draft.id ? "已有条目不可修改 ID" : undefined}>
          {(props) => (
            <Input {...props} value={draft.id} readOnly={Boolean(draft.id)} onChange={(event) => patch({ id: event.target.value })} />
          )}
        </Field>
        <Field label="显示名称（留空继承）" id="model-override-display">
          {(props) => <Input {...props} value={draft.display_name} onChange={(event) => patch({ display_name: event.target.value })} />}
        </Field>
        <Field label="上下文窗口（token，留空继承）" id="model-override-context">
          {(props) => <Input {...props} type="number" min="0" value={draft.context_window} onChange={(event) => patch({ context_window: event.target.value })} />}
        </Field>
        <Field label="最大输出（token，留空继承）" id="model-override-output">
          {(props) => <Input {...props} type="number" min="0" value={draft.max_output_tokens} onChange={(event) => patch({ max_output_tokens: event.target.value })} />}
        </Field>
        <Field label="模型状态" id="model-override-status">
          {(props) => (
            <select {...props} value={draft.status} onChange={(event) => patch({ status: event.target.value })} className="border border-line bg-input px-3 py-2 text-sm text-ink outline-none">
              <option value="">继承</option>
              <option value="active">正式</option>
              <option value="beta">测试版</option>
              <option value="deprecated">已弃用</option>
            </select>
          )}
        </Field>
        <Field label="本地启用状态" id="model-override-enabled">
          {(props) => (
            <select {...props} value={draft.enabled} onChange={(event) => patch({ enabled: event.target.value })} className="border border-line bg-input px-3 py-2 text-sm text-ink outline-none">
              <option value="">继承（启用）</option>
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
          )}
        </Field>
        <Field label="输入价格（美元 / 百万 token）" id="model-override-price-in">
          {(props) => <Input {...props} type="number" min="0" step="any" value={draft.inputPrice} onChange={(event) => patch({ inputPrice: event.target.value })} />}
        </Field>
        <Field label="输出价格（美元 / 百万 token）" id="model-override-price-out">
          {(props) => <Input {...props} type="number" min="0" step="any" value={draft.outputPrice} onChange={(event) => patch({ outputPrice: event.target.value })} />}
        </Field>
      </div>
      <fieldset className="mt-3 border border-line p-2">
        <legend className="px-1 text-xs font-bold">输入 / 输出模态</legend>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={draft.modalitiesInherit}
            onChange={(event) => patch({ modalitiesInherit: event.target.checked })}
          />
          继承目录模态
        </label>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {(["inputModalities", "outputModalities"] as const).map((direction) => (
            <div key={direction}>
              <p className="m-0 text-xs font-semibold">{direction === "inputModalities" ? "输入" : "输出"}</p>
              {MODALITY_OPTIONS.map((value, index) => (
                <label key={value} className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    value={value}
                    disabled={draft.modalitiesInherit}
                    checked={draft[direction].includes(value)}
                    onChange={() => toggleModality(direction, value)}
                  />
                  {["文本", "图像", "音频", "视频", "PDF"][index]}
                </label>
              ))}
            </div>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        {CAPABILITY_KEYS.map((key) => (
          <Field key={key} label={`${CAPABILITY_LABELS[key]} · 声明能力`} id={`model-override-claim-${key}`}>
            {(props) => (
              <select
                {...props}
                value={draft.claims[key]}
                onChange={(event) => patch({ claims: { ...draft.claims, [key]: event.target.value } })}
                className="border border-line bg-input px-3 py-2 text-sm text-ink outline-none"
              >
                <option value="">继承</option>
                <option value="true">声明支持</option>
                <option value="false">未声明支持</option>
              </select>
            )}
          </Field>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={disabled || busy} onClick={onSave}>{busy ? "保存中…" : "保存本地模型"}</Button>
        <Button variant="secondary" disabled={disabled || busy} onClick={() => onChange(emptyModelOverrideDraft())}>新增另一模型</Button>
        <Button variant="secondary" onClick={onCancel}>收起表单</Button>
        <span className="text-xs text-muted">基于 revision {revision} 提交（CAS）</span>
      </div>
    </details>
  );
}

/** revision 冲突不覆盖服务器版本：保留本地表单并提示刷新比较。 */
function overrideErrorMessage(cause: unknown): string {
  if (cause instanceof ConsoleApiError && (cause.code === "config_conflict" || cause.status === 409)) {
    return "模型信息已被其他操作修改，未覆盖服务器版本。请刷新模型信息后重试；本地输入已保留。";
  }
  return cause instanceof Error ? cause.message : "模型保存失败";
}
