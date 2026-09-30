import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ConsoleApiError,
  testProviderConnection,
  updateAgentConfiguration,
  updateConnectionCredential,
} from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/dialog.js";
import { FormDialog } from "../../components/ui/form-dialog.js";
import { Field, Input } from "../../components/ui/field.js";
import { showToast } from "../../stores/toast.js";
import type { ConfigFieldSnapshot, ConfigurationSnapshot } from "../../types.js";
import { PublicFieldRow } from "./configuration-field-row.js";
import { ModelManagerDialog } from "./model-manager-dialog.js";
import {
  hasCanonicalProvider,
  removeProviderChange,
  savedProvidersOf,
  setProviderChange,
  type ConnectionFormValues,
} from "./provider-connection.js";

/** 服务端受信预设；Credential 明文只存在于本次输入与请求，服务端不回传也不落前端持久状态。 */
const BUILTIN_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ["openai", "OpenAI"],
  ["deepseek", "DeepSeek"],
  ["bigmodel", "智谱 BigModel"],
  ["gemini", "Gemini"],
];

const DIAGNOSTIC_LABELS: Record<string, string> = { success: "成功", failed: "失败", unknown: "无法确认", not_tested: "未测试" };

type ConnectionCredentialStatus = NonNullable<ConfigurationSnapshot["providers"]>["credentials"][string];

type ProviderConnectionsProps = {
  snapshot: ConfigurationSnapshot;
  /** provider.* 配置字段；公开字段渲染进内置连接卡片，secret 字段仍留在密钥凭据区。 */
  fields: readonly ConfigFieldSnapshot[];
  publicDraft: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
  onResult: (result: { error: boolean; text: string }) => void;
};

/** 供应商连接管理：内置连接展示、自定义连接增删改、Credential 与连接测试、模型管理入口。
 * 契约：保存走 set_provider / remove_provider；测试是真实最小模型调用；
 * 获取模型成功不等于连接健康；删除被 Route 引用时的服务端拒绝原样展示，不伪造成功。 */
export function ProviderConnections({ snapshot, fields, publicDraft, onDraftChange, onResult }: ProviderConnectionsProps) {
  const [creating, setCreating] = useState(false);
  const [modelManagerFor, setModelManagerFor] = useState<string | null>(null);
  const saved = useMemo(() => savedProvidersOf(snapshot.agent), [snapshot.agent]);
  const credentials = snapshot.providers?.credentials ?? {};
  const presets = snapshot.providers?.presets ?? [];

  const builtinCards = BUILTIN_PROVIDERS.map(([id, name]) => ({
    id,
    name,
    fields: fields.filter((field) => field.key.startsWith(`provider.${id}.`) && field.sensitivity !== "secret"),
  })).filter((card) => card.fields.length > 0);

  const customIds = Object.keys(saved).sort((left, right) => left.localeCompare(right));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="m-0 text-base font-bold">供应商连接</h3>
          <p className="m-0 mt-1 text-xs leading-relaxed text-muted">
            选择受信预设或创建自定义连接。保存后重启生效；Connection ID 创建后不能修改。
          </p>
        </div>
        <Button disabled={snapshot.agent?.editable !== true} onClick={() => setCreating(true)}>+ 新建供应商</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {builtinCards.map((card) => (
          <BuiltinConnectionCard
            key={card.id}
            snapshot={snapshot}
            id={card.id}
            name={card.name}
            fields={card.fields}
            onDraftChange={onDraftChange}
            publicDraft={publicDraft}
            onModelManager={() => setModelManagerFor(card.id)}
          />
        ))}
        {customIds.map((id) => (
          <CustomConnectionCard
            key={id}
            snapshot={snapshot}
            id={id}
            saved={saved[id] ?? {}}
            credential={credentials[id]}
            onResult={onResult}
            onModelManager={() => setModelManagerFor(id)}
          />
        ))}
      </div>

      {creating ? (
        <CreateConnectionDialog
          snapshot={snapshot}
          presets={presets}
          saved={saved}
          onClose={() => setCreating(false)}
          onResult={onResult}
        />
      ) : null}
      {modelManagerFor !== null ? (
        <ModelManagerDialog
          snapshot={snapshot}
          connection={modelManagerFor}
          enabled={connectionEnabledFor(modelManagerFor, snapshot, fields)}
          discoveryRevision={saved[modelManagerFor] ? snapshot.agent!.revision : snapshot.revision}
          onClose={() => setModelManagerFor(null)}
        />
      ) : null}
    </div>
  );
}

/** 内置连接启用状态来自运行字段；自定义连接来自保存配置。 */
function connectionEnabledFor(id: string, snapshot: ConfigurationSnapshot, fields: readonly ConfigFieldSnapshot[]): boolean {
  const custom = savedProvidersOf(snapshot.agent)[id];
  if (custom && Object.keys(custom).length > 0) return custom.enabled !== false;
  return fields.find((field) => field.key === `provider.${id}.enabled`)?.effectiveValue !== false;
}

function BuiltinConnectionCard({ snapshot, id, name, fields, publicDraft, onDraftChange, onModelManager }: {
  snapshot: ConfigurationSnapshot;
  id: string;
  name: string;
  fields: readonly ConfigFieldSnapshot[];
  publicDraft: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
  onModelManager: () => void;
}) {
  // 内置连接的密钥字段留在密钥凭据区；卡片只保留公开字段与诊断入口。
  const enabledField = fields.find((field) => field.key.endsWith(".enabled"));
  const enabled = enabledField?.effectiveValue !== false;
  // 测试结果缓存键需要包含密钥 revision：密钥替换后旧诊断结论不再可信。
  const secretRevision = snapshot.fields
    .find((field) => field.key.startsWith(`provider.${id}.`) && field.sensitivity === "secret")?.revision ?? "";
  return (
    <section aria-label={`内置连接 ${id}`} className="border border-line bg-glass-muted p-4">
      <h4 className="m-0 text-sm font-bold">{name} · {id}</h4>
      <p className="m-0 mt-1 text-xs text-muted">内置连接：保留原配置来源，字段随「保存普通配置」提交。</p>
      <div className="mt-3 flex flex-col gap-3">
        {fields.map((field) => (
          <PublicFieldRow
            key={field.key}
            field={field}
            value={publicDraft[field.key]}
            onChange={(value) => onDraftChange(field.key, value)}
          />
        ))}
      </div>
      <ConnectionTestPanel
        id={id}
        revision={snapshot.revision}
        credentialRevision={secretRevision}
        enabled={enabled}
      />
      <div className="mt-2">
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onModelManager}>管理模型</Button>
      </div>
    </section>
  );
}

function CustomConnectionCard({ snapshot, id, saved, credential, onResult, onModelManager }: {
  snapshot: ConfigurationSnapshot;
  id: string;
  saved: Record<string, unknown>;
  credential: ConnectionCredentialStatus | undefined;
  onResult: (result: { error: boolean; text: string }) => void;
  onModelManager: () => void;
}) {
  const queryClient = useQueryClient();
  const agent = snapshot.agent!;
  const presets = snapshot.providers?.presets ?? [];
  const preset = presets.find((candidate) => candidate.id === id);
  const running = providerRecord(agent.runningValue, id);
  const [values, setValues] = useState<ConnectionFormValues>(() => formValuesFromSaved(id, saved, preset));
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [clearingCredential, setClearingCredential] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const dirty = JSON.stringify(formValuesFromSaved(id, saved, preset)) !== JSON.stringify(values);
  const pending = JSON.stringify(saved) !== JSON.stringify(running) || credential?.pending_restart === true;

  const agentChange = useMutation({
    mutationFn: ({ changes }: { changes: unknown[] }) => updateAgentConfiguration(agent.revision, changes),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["configuration"] });
      const action = typeof variables.changes[0] === "object" && variables.changes[0] !== null
        ? (variables.changes[0] as Record<string, unknown>).action
        : "";
      const text = action === "remove_provider"
        ? `供应商 ${id} 已删除；专属 Credential 将归档，重启后生效。`
        : `供应商 ${id} 已保存，重启后生效。`;
      setError("");
      onResult({ error: false, text });
      showToast("info", text);
    },
    onError: (cause) => {
      setError(agentActionErrorMessage(cause));
      onResult({ error: true, text: agentActionErrorMessage(cause) });
    },
  });

  const credentialChange = useMutation({
    mutationFn: ({ value }: { value: string | null }) => updateConnectionCredential(id, agent.revision, credential?.revision ?? "missing", value),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["configuration"] });
      // 成功后立即清空本地输入；明文只存在于本次输入与请求，不进入任何持久状态。
      setKeyDraft("");
      const text = variables.value === null ? `供应商 ${id} 的 Credential 已清除。` : `供应商 ${id} 的 API Key 已保存，原文不会再次显示。`;
      setError("");
      onResult({ error: false, text });
      showToast("info", text);
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "Credential 保存失败");
      onResult({ error: true, text: cause instanceof Error ? cause.message : "Credential 保存失败" });
    },
  });

  const saveConnection = () => {
    setError("");
    let change: Record<string, unknown>;
    try {
      // 已有连接只按原始 ID 精确提交；新建连接的大小写冲突在创建对话框中校验。
      change = setProviderChange(id, values, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection ID 无效");
      return;
    }
    agentChange.mutate({ changes: [change] });
  };

  const credentialEditable = credential?.editable === true;
  return (
    <section aria-label={`自定义连接 ${id}`} className="border border-line bg-glass-muted p-4">
      <h4 className="m-0 text-sm font-bold">{typeof saved.display_name === "string" && saved.display_name ? saved.display_name : preset?.name ?? id}</h4>
      <p className="m-0 mt-1 text-xs text-muted">
        保存：{saved.enabled === false ? "停用" : "启用"} ·
        运行：{Object.keys(running).length ? running.enabled === false ? "停用" : "启用" : "未加载"} ·
        {" "}{pending ? "等待重启" : "已生效"}
      </p>
      <p className="m-0 text-xs text-muted">Credential：{credential?.configured ? "已配置" : "未配置"}</p>
      {dirty ? <p className="m-0 text-xs text-warning">表单有未保存修改</p> : null}

      <div className="mt-3 flex flex-col gap-3">
        <Field label="Connection ID" id={`connection-${id}-identity`} hint="创建后不能修改">
          {(props) => <Input {...props} value={id} disabled readOnly />}
        </Field>
        <Field label="显示名称" id={`connection-${id}-display`}>
          {(props) => <Input {...props} value={values.display_name} onChange={(event) => setValues({ ...values, display_name: event.target.value })} />}
        </Field>
        <Field label="协议 Adapter" id={`connection-${id}-kind`}>
          {(props) => (
            <select
              {...props}
              value={values.kind}
              onChange={(event) => setValues({ ...values, kind: event.target.value })}
              className="border border-line bg-input px-3 py-2 text-sm text-ink outline-none"
            >
              {(snapshot.providers?.adapters ?? []).map((adapter) => (
                <option key={adapter} value={adapter}>{adapter}</option>
              ))}
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(event) => setValues({ ...values, enabled: event.target.checked })}
          />
          启用供应商
        </label>
        <Field label="Base URL" id={`connection-${id}-base-url`}>
          {(props) => <Input {...props} value={values.base_url} onChange={(event) => setValues({ ...values, base_url: event.target.value })} />}
        </Field>
        <details>
          <summary className="cursor-pointer text-xs font-semibold">请求配置</summary>
          <div className="mt-2 flex flex-col gap-3">
            <Field label="认证 Header" id={`connection-${id}-auth-header`}>
              {(props) => <Input {...props} value={values.auth_header} onChange={(event) => setValues({ ...values, auth_header: event.target.value })} />}
            </Field>
            <Field label="认证 Scheme（空表示无前缀）" id={`connection-${id}-auth-scheme`}>
              {(props) => <Input {...props} value={values.auth_scheme} onChange={(event) => setValues({ ...values, auth_scheme: event.target.value })} />}
            </Field>
            <Field label="请求超时（秒，可留空）" id={`connection-${id}-timeout`}>
              {(props) => <Input {...props} type="number" min="0" value={values.request_timeout_seconds} onChange={(event) => setValues({ ...values, request_timeout_seconds: event.target.value })} />}
            </Field>
            <p className="m-0 text-xs text-muted">Credential 引用：{stringField(saved.api_key_env)}（不可修改）</p>
          </div>
        </details>
      </div>

      {error ? <p role="alert" className="m-0 mt-2 text-xs font-semibold text-error">{error}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={agentChange.isPending || snapshot.agent?.editable !== true} onClick={saveConnection}>
          {agentChange.isPending ? "保存中…" : "保存连接"}
        </Button>
        <Button variant="danger" disabled={agentChange.isPending || snapshot.agent?.editable !== true} onClick={() => setConfirmingDelete(true)}>
          删除供应商
        </Button>
      </div>

      {credentialEditable ? (
        <div className="mt-4 border-t border-line-inner pt-3">
          <Field label="新增 / 替换 API Key" id={`connection-${id}-api-key`}>
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
            )}
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={credentialChange.isPending || snapshot.agent?.editable !== true}
              onClick={() => {
                const value = keyDraft;
                setKeyDraft("");
                if (!value.trim()) {
                  setError("请输入 API Key");
                  return;
                }
                credentialChange.mutate({ value });
              }}
            >
              保存 API Key
            </Button>
            <Button
              variant="secondary"
              disabled={credentialChange.isPending || snapshot.agent?.editable !== true || !credential?.configured}
              onClick={() => setClearingCredential(true)}
            >
              清除 API Key
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 mt-2 text-xs text-muted">历史环境变量凭证需在部署环境中修改。</p>
      )}

      <ConnectionTestPanel
        id={id}
        revision={agent.revision}
        credentialRevision={credential?.revision ?? ""}
        enabled={snapshot.agent?.editable === true && saved.enabled !== false}
      />
      <div className="mt-2">
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onModelManager}>管理模型</Button>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`删除供应商 ${id}`}
        description="仍被路线引用时会拒绝，专属 Credential 将归档。确认删除？"
        confirmLabel="删除"
        danger
        busy={agentChange.isPending}
        onConfirm={() => {
          setConfirmingDelete(false);
          agentChange.mutate({ changes: [removeProviderChange(id)] });
        }}
      />
      <ConfirmDialog
        open={clearingCredential}
        onOpenChange={setClearingCredential}
        title="清除 API Key"
        description="确定清除此 Credential？历史共享引用可能影响其他连接。"
        confirmLabel="清除"
        danger
        busy={credentialChange.isPending}
        onConfirm={() => {
          setClearingCredential(false);
          credentialChange.mutate({ value: null });
        }}
      />
    </section>
  );
}

function CreateConnectionDialog({ snapshot, presets, saved, onClose, onResult }: {
  snapshot: ConfigurationSnapshot;
  presets: NonNullable<ConfigurationSnapshot["providers"]>["presets"];
  saved: Record<string, Record<string, unknown>>;
  onClose: () => void;
  onResult: (result: { error: boolean; text: string }) => void;
}) {
  const queryClient = useQueryClient();
  const agent = snapshot.agent!;
  const [presetId, setPresetId] = useState("");
  const [identity, setIdentity] = useState("");
  const [values, setValues] = useState<ConnectionFormValues>(() => ({
    display_name: "",
    enabled: true,
    kind: "openai_compatible",
    base_url: "",
    auth_header: "Authorization",
    auth_scheme: "Bearer",
    request_timeout_seconds: "",
  }));
  const [error, setError] = useState("");

  const applyPreset = (nextPresetId: string) => {
    setPresetId(nextPresetId);
    const preset = presets.find((candidate) => candidate.id === nextPresetId);
    setValues((current) => preset
      ? { ...current, kind: preset.kind, base_url: preset.base_url, auth_header: preset.auth_header, auth_scheme: preset.auth_scheme }
      : { ...current, kind: "openai_compatible" });
  };

  const create = useMutation({
    mutationFn: ({ changes }: { changes: unknown[] }) => updateAgentConfiguration(agent.revision, changes),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["configuration"] });
      onResult({ error: false, text: `供应商 ${identity.trim()} 已创建，重启后生效。` });
      showToast("info", `供应商 ${identity.trim()} 已创建，重启后生效。`);
      onClose();
    },
    onError: (cause) => setError(agentActionErrorMessage(cause)),
  });

  const submit = () => {
    setError("");
    // 先按服务端 prepare 语义拒绝大小写别名冲突，再做 ID 语法校验（与旧版交互一致）。
    if (hasCanonicalProvider(saved, identity)) {
      setError("该 Connection ID 已存在（大小写不敏感），请使用新的 ID");
      return;
    }
    let change: Record<string, unknown>;
    try {
      change = setProviderChange(identity, values, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection ID 无效");
      return;
    }
    create.mutate({ changes: [change] });
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="新建供应商"
      description="选择受信预设或从空白自定义连接开始；Credential slot 由服务端在保存时生成。"
      footer={<p role="alert" className="m-0 text-xs font-semibold text-error">{error}</p>}
    >
      <Field label="供应商预设" id="create-provider-preset">
        {(props) => (
          <select
            {...props}
            value={presetId}
            onChange={(event) => applyPreset(event.target.value)}
            className="border border-line bg-input px-3 py-2 text-sm text-ink outline-none"
          >
            <option value="">自定义连接</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Connection ID" id="create-provider-identity" hint="小写字母、数字、下划线或连字符；创建后不能修改">
        {(props) => <Input {...props} value={identity} onChange={(event) => setIdentity(event.target.value)} />}
      </Field>
      <Field label="显示名称" id="create-provider-display">
        {(props) => <Input {...props} value={values.display_name} onChange={(event) => setValues({ ...values, display_name: event.target.value })} />}
      </Field>
      <Field label="协议 Adapter" id="create-provider-kind">
        {(props) => (
          <select
            {...props}
            value={values.kind}
            onChange={(event) => setValues({ ...values, kind: event.target.value })}
            className="border border-line bg-input px-3 py-2 text-sm text-ink outline-none"
          >
            {(snapshot.providers?.adapters ?? []).map((adapter) => (
              <option key={adapter} value={adapter}>{adapter}</option>
            ))}
          </select>
        )}
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={values.enabled} onChange={(event) => setValues({ ...values, enabled: event.target.checked })} />
        启用供应商
      </label>
      <Field label="Base URL" id="create-provider-base-url">
        {(props) => <Input {...props} value={values.base_url} onChange={(event) => setValues({ ...values, base_url: event.target.value })} />}
      </Field>
      <details>
        <summary className="cursor-pointer text-xs font-semibold">请求配置</summary>
        <div className="mt-2 flex flex-col gap-3">
          <Field label="认证 Header" id="create-provider-auth-header">
            {(props) => <Input {...props} value={values.auth_header} onChange={(event) => setValues({ ...values, auth_header: event.target.value })} />}
          </Field>
          <Field label="认证 Scheme（空表示无前缀）" id="create-provider-auth-scheme">
            {(props) => <Input {...props} value={values.auth_scheme} onChange={(event) => setValues({ ...values, auth_scheme: event.target.value })} />}
          </Field>
          <Field label="请求超时（秒，可留空）" id="create-provider-timeout">
            {(props) => <Input {...props} type="number" min="0" value={values.request_timeout_seconds} onChange={(event) => setValues({ ...values, request_timeout_seconds: event.target.value })} />}
          </Field>
        </div>
      </details>
      <div className="flex items-center gap-3">
        <Button disabled={create.isPending} onClick={submit}>{create.isPending ? "创建中…" : "创建连接"}</Button>
      </div>
    </FormDialog>
  );
}

function ConnectionTestPanel({ id, revision, credentialRevision, enabled }: {
  id: string;
  revision: string;
  credentialRevision: string;
  enabled: boolean;
}) {
  const [model, setModel] = useState("");
  const [lastTest, setLastTest] = useState<{ key: string; text: string } | null>(null);
  const cacheKey = `${id}:${revision}:${credentialRevision}`;
  const test = useMutation({
    mutationFn: () => testProviderConnection(id, revision, model.trim()),
    onSuccess: (result) => {
      setLastTest({
        key: cacheKey,
        text: `网络：${DIAGNOSTIC_LABELS[String(result.network)] ?? String(result.network)} ·` +
          ` 认证：${DIAGNOSTIC_LABELS[String(result.authentication)] ?? String(result.authentication)} ·` +
          ` 协议：${DIAGNOSTIC_LABELS[String(result.adapter)] ?? String(result.adapter)} ·` +
          ` 模型调用：${DIAGNOSTIC_LABELS[String(result.model_call)] ?? String(result.model_call)} ·` +
          ` ${String(result.elapsed_ms)} ms · HTTP ${result.http_status == null ? "未知" : String(result.http_status)} · ${String(result.category)}`,
      });
    },
    onError: (cause) => setLastTest({ key: cacheKey, text: cause instanceof Error ? cause.message : "连接测试失败" }),
  });
  return (
    <div className="mt-4 border-t border-line-inner pt-3">
      <Field label="测试模型 ID（将产生一次最小真实调用）" id={`connection-${id}-test-model`}>
        {(props) => <Input {...props} value={model} disabled={!enabled} onChange={(event) => setModel(event.target.value)} />}
      </Field>
      <div className="mt-2">
        <Button variant="secondary" disabled={!enabled || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? "正在测试…" : "测试已保存连接"}
        </Button>
      </div>
      <p role="status" className="m-0 mt-2 text-xs text-muted">
        {lastTest?.key === cacheKey ? lastTest.text : "最近测试：尚未测试"}
      </p>
    </div>
  );
}

function formValuesFromSaved(id: string, saved: Record<string, unknown>, preset: { name?: string; kind: string; base_url: string; auth_header: string; auth_scheme: string } | undefined): ConnectionFormValues {
  return {
    display_name: stringField(saved.display_name) || preset?.name || id,
    enabled: saved.enabled !== false,
    kind: stringField(saved.kind) || preset?.kind || "openai_compatible",
    base_url: stringField(saved.base_url),
    auth_header: stringField(saved.auth_header) || "Authorization",
    auth_scheme: "auth_scheme" in saved ? (saved.auth_scheme === null ? "" : stringField(saved.auth_scheme) || "Bearer") : "Bearer",
    request_timeout_seconds: saved.request_timeout_seconds == null ? "" : String(saved.request_timeout_seconds),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function providerRecord(agentValue: unknown, id: string): Record<string, unknown> {
  const root = typeof agentValue === "object" && agentValue !== null && !Array.isArray(agentValue) ? agentValue as Record<string, unknown> : {};
  const providers = typeof root.providers === "object" && root.providers !== null && !Array.isArray(root.providers) ? root.providers as Record<string, unknown> : {};
  const provider = providers[id];
  return typeof provider === "object" && provider !== null && !Array.isArray(provider) ? provider as Record<string, unknown> : {};
}

/** revision 冲突不覆盖服务器版本：保留本地输入并提示刷新比较。 */
function agentActionErrorMessage(cause: unknown): string {
  if (cause instanceof ConsoleApiError && (cause.code === "config_conflict" || cause.status === 409)) {
    return "配置已被其他操作修改，未覆盖服务器版本。请刷新后比较本地修改和服务器当前值；本地输入已保留。";
  }
  return cause instanceof Error ? cause.message : "配置保存失败";
}
