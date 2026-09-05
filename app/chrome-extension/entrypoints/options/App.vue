<template>
  <div class="op-page agent-theme">
    <div class="op-inner">
      <header class="op-topbar">
        <h1 class="ac-title">{{ m('options_page_title') }}</h1>
        <label class="op-emergency">
          <span class="op-emergency-text">
            <span class="ac-body">{{ m('emergencySwitchLabel') }}</span>
            <span class="ac-caption">{{ m('options_emergency_desc') }}</span>
          </span>
          <span class="ac-switch">
            <input
              type="checkbox"
              v-model="emergencyDisabled"
              :aria-label="m('emergencySwitchLabel')"
              @change="saveEmergency"
            />
            <span class="ac-switch-track"></span>
          </span>
        </label>
      </header>

      <section class="ac-card op-card">
        <h2 class="ac-heading">{{ m('createRunSectionTitle') }}</h2>

        <div class="op-grid">
          <label class="op-field">
            <span class="op-label">{{ m('nameLabel') }}</span>
            <input class="ac-field" v-model="form.name" :placeholder="m('placeholderOptional')" />
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('runAtLabel') }}</span>
            <select class="ac-field" v-model="form.runAt">
              <option value="auto">{{ m('runAtAuto') }}</option>
              <option value="document_start">{{ m('runAtDocumentStart') }}</option>
              <option value="document_end">{{ m('runAtDocumentEnd') }}</option>
              <option value="document_idle">{{ m('runAtDocumentIdle') }}</option>
            </select>
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('worldLabel') }}</span>
            <select class="ac-field" v-model="form.world">
              <option value="auto">{{ m('worldAuto') }}</option>
              <option value="ISOLATED">{{ m('worldIsolated') }}</option>
              <option value="MAIN">{{ m('worldMain') }}</option>
            </select>
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('modeLabel') }}</span>
            <select class="ac-field" v-model="form.mode">
              <option value="auto">{{ m('modeAuto') }}</option>
              <option value="persistent">{{ m('modePersistent') }}</option>
              <option value="css">{{ m('modeCss') }}</option>
              <option value="once">{{ m('modeOnce') }}</option>
            </select>
          </label>
        </div>

        <div class="op-checks">
          <label class="op-check">
            <input class="ac-check" type="checkbox" v-model="form.allFrames" />
            <span class="ac-body">{{ m('allFramesLabel') }}</span>
          </label>
          <label class="op-check">
            <input class="ac-check" type="checkbox" v-model="form.persist" />
            <span class="ac-body">{{ m('persistLabel') }}</span>
          </label>
          <label class="op-check">
            <input class="ac-check" type="checkbox" v-model="form.dnrFallback" />
            <span class="ac-body">{{ m('dnrFallbackLabel') }}</span>
          </label>
        </div>

        <div class="op-stack">
          <label class="op-field">
            <span class="op-label">{{ m('matchesInputLabel') }}</span>
            <input
              class="ac-field"
              v-model="form.matches"
              :placeholder="m('placeholderMatchesExample')"
            />
            <span class="ac-caption">{{ m('options_form_hint') }}</span>
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('excludesInputLabel') }}</span>
            <input
              class="ac-field"
              v-model="form.excludes"
              :placeholder="m('placeholderOptional')"
            />
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('tagsInputLabel') }}</span>
            <input class="ac-field" v-model="form.tags" :placeholder="m('placeholderOptional')" />
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('scriptLabel') }}</span>
            <textarea
              class="ac-field ac-field--mono op-script"
              v-model="form.script"
              :placeholder="m('placeholderScriptHint')"
              rows="8"
            />
          </label>
        </div>

        <div class="op-actions">
          <button
            type="button"
            class="ac-button ac-button--primary"
            :disabled="submitting"
            @click="apply('auto')"
          >
            {{ m('applyButton') }}
          </button>
          <button
            type="button"
            class="ac-button ac-button--ghost"
            :disabled="submitting"
            @click="apply('once')"
          >
            {{ m('runOnceButton') }}
          </button>
          <span v-if="lastResult" class="ac-caption op-result">{{ lastResult }}</span>
        </div>
      </section>

      <section class="ac-card op-card">
        <h2 class="ac-heading">{{ m('listSectionTitle') }}</h2>

        <div class="op-grid">
          <label class="op-field">
            <span class="op-label">{{ m('queryLabel') }}</span>
            <input class="ac-field" v-model="filters.query" @input="reload()" />
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('statusLabel') }}</span>
            <select class="ac-field" v-model="filters.status" @change="reload()">
              <option value="">{{ m('statusAll') }}</option>
              <option value="enabled">{{ m('statusEnabled') }}</option>
              <option value="disabled">{{ m('statusDisabled') }}</option>
            </select>
          </label>
          <label class="op-field">
            <span class="op-label">{{ m('domainLabel') }}</span>
            <input
              class="ac-field"
              v-model="filters.domain"
              :placeholder="m('placeholderDomainHint')"
              @input="reload()"
            />
          </label>
        </div>

        <div class="op-actions">
          <button type="button" class="ac-button ac-button--ghost" @click="exportAll">
            {{ m('exportAllButton') }}
          </button>
        </div>

        <div class="op-table-wrap">
          <table class="op-table">
            <thead>
              <tr>
                <th class="op-th">{{ m('tableHeaderName') }}</th>
                <th class="op-th">{{ m('statusLabel') }}</th>
                <th class="op-th">{{ m('tableHeaderWorld') }}</th>
                <th class="op-th">{{ m('tableHeaderRunAt') }}</th>
                <th class="op-th">{{ m('tableHeaderUpdated') }}</th>
                <th class="op-th"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in items" :key="it.id" class="op-tr">
                <td class="op-td">
                  <span class="ac-body ac-clip" :title="it.name || it.id">{{
                    it.name || it.id
                  }}</span>
                </td>
                <td class="op-td">
                  <span class="op-status">
                    <span class="ac-switch">
                      <input
                        type="checkbox"
                        :checked="it.status === 'enabled'"
                        :aria-label="it.name || it.id"
                        @change="toggle(it)"
                      />
                      <span class="ac-switch-track"></span>
                    </span>
                    <span
                      class="ac-badge"
                      :class="it.status === 'enabled' ? 'ac-badge--accent' : ''"
                      >{{
                        it.status === 'enabled' ? m('statusEnabled') : m('statusDisabled')
                      }}</span
                    >
                  </span>
                </td>
                <td class="op-td"
                  ><span class="ac-sub">{{ it.world }}</span></td
                >
                <td class="op-td"
                  ><span class="ac-sub">{{ it.runAt }}</span></td
                >
                <td class="op-td">
                  <span class="ac-sub ac-num">{{ formatTime(it.updatedAt) }}</span>
                </td>
                <td class="op-td op-td--right">
                  <button
                    type="button"
                    class="ac-button ac-button--danger ac-button--sm"
                    @click="remove(it)"
                  >
                    {{ m('deleteButton') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { STORAGE_KEYS } from '@/common/constants';

type ListItem = {
  id: string;
  name?: string;
  status: 'enabled' | 'disabled';
  world: 'ISOLATED' | 'MAIN';
  runAt: 'document_start' | 'document_end' | 'document_idle';
  updatedAt: number;
};

const emergencyDisabled = ref(false);
const items = ref<ListItem[]>([]);
const filters = ref({ query: '', status: '', domain: '' });

const form = ref({
  name: '',
  runAt: 'auto',
  world: 'auto',
  mode: 'auto',
  allFrames: true,
  persist: true,
  dnrFallback: true,
  script: '',
  matches: '',
  excludes: '',
  tags: '',
});

const submitting = ref(false);
const lastResult = ref('');

function formatTime(ts?: number) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

async function saveEmergency() {
  await globalThis.chrome?.storage?.local.set({
    [STORAGE_KEYS.USERSCRIPTS_DISABLED]: emergencyDisabled.value,
  });
}

async function loadEmergency() {
  const v = await globalThis.chrome?.storage?.local.get([STORAGE_KEYS.USERSCRIPTS_DISABLED] as any);
  emergencyDisabled.value = !!v[STORAGE_KEYS.USERSCRIPTS_DISABLED];
}

async function callTool(name: string, args: any) {
  const res = await globalThis.chrome?.runtime?.sendMessage({
    type: 'call_tool',
    name,
    args,
  } as any);
  if (!res || !res.success) throw new Error(res?.error || 'call failed');
  return res.result;
}

async function reload() {
  const result = await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, {
    action: 'list',
    args: { ...filters.value },
  });
  try {
    const txt = (result?.content?.[0]?.text as string) || '{}';
    const data = JSON.parse(txt);
    items.value = data.items || [];
  } catch (e) {
    console.warn('parse list failed', e);
  }
}

async function apply(mode: 'auto' | 'once') {
  if (!form.value.script.trim()) return;
  submitting.value = true;
  lastResult.value = '';
  try {
    const args: any = {
      script: form.value.script,
      name: form.value.name || undefined,
      runAt: form.value.runAt as any,
      world: form.value.world as any,
      allFrames: !!form.value.allFrames,
      persist: !!form.value.persist,
      dnrFallback: !!form.value.dnrFallback,
      mode,
    };
    if (form.value.matches.trim())
      args.matches = form.value.matches.split(',').map((s) => s.trim());
    if (form.value.excludes.trim())
      args.excludes = form.value.excludes.split(',').map((s) => s.trim());
    if (form.value.tags.trim()) args.tags = form.value.tags.split(',').map((s) => s.trim());

    const result = await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, { action: 'create', args });
    lastResult.value = (result?.content?.[0]?.text as string) || '';
    await reload();
  } catch (e: any) {
    lastResult.value = 'Error: ' + (e?.message || String(e));
  } finally {
    submitting.value = false;
  }
}

async function toggle(it: ListItem) {
  try {
    await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, {
      action: it.status === 'enabled' ? 'disable' : 'enable',
      args: { id: it.id },
    });
    await reload();
  } catch (e) {
    console.warn('toggle failed', e);
  }
}

async function remove(it: ListItem) {
  try {
    await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, { action: 'remove', args: { id: it.id } });
    await reload();
  } catch (e) {
    console.warn('remove failed', e);
  }
}

async function exportAll() {
  try {
    const res = await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, { action: 'export', args: {} });
    const txt = (res?.content?.[0]?.text as string) || '{}';
    const blob = new Blob([txt], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    await globalThis.chrome?.downloads?.download({
      url,
      filename: 'userscripts-export.json',
      saveAs: true,
    } as any);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('export failed', e);
  }
}

onMounted(async () => {
  await loadEmergency();
  await reload();
});

function m(key: string, substitutions?: string | string[]) {
  const msg = (globalThis.chrome?.i18n?.getMessage(key, substitutions as any) || '').trim();
  return msg || key;
}
</script>

<style>
/* 옵션 페이지는 탭 하나를 통째로 쓴다. 바탕이 끝까지 이어지도록 body 여백만 지운다. */
html,
body {
  margin: 0;
  padding: 0;
}
</style>

<style scoped>
/* 레이아웃만. 색·글꼴·입력·버튼·스위치는 ui/theme.css 의 .ac-* 가 그린다. */
.op-page {
  min-height: 100vh;
  padding: 24px 16px 48px;
}

.op-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 960px;
  margin: 0 auto;
}

.op-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.op-emergency {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  cursor: pointer;
}

.op-emergency-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.op-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
}

.op-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.op-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.op-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

/* 섹션 라벨 */
.op-label {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  color: var(--ac-text-secondary);
}

.op-script {
  min-height: 160px;
  font-size: 13px;
  line-height: 20px;
}

.op-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}

.op-check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  cursor: pointer;
}

.op-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.op-result {
  word-break: break-word;
}

.op-table-wrap {
  overflow-x: auto;
}

.op-table {
  width: 100%;
  border-collapse: collapse;
}

/* 표 머리글도 섹션 라벨과 같은 규격 */
.op-th {
  padding: 0 8px 8px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  color: var(--ac-text-secondary);
  white-space: nowrap;
  box-shadow: inset 0 -0.75px 0 0 var(--ac-divider);
}

.op-tr {
  transition: background-color var(--ac-motion-fast) ease;
}

@media (hover: hover) and (pointer: fine) {
  .op-tr:hover {
    background-color: var(--ac-surface-hover);
  }
}

.op-td {
  height: 44px;
  padding: 0 8px;
  vertical-align: middle;
  box-shadow: inset 0 -0.75px 0 0 var(--ac-divider);
}

.op-td--right {
  text-align: right;
}

/* 긴 이름은 한 줄 말줄임 (title 속성으로 전체를 볼 수 있다). */
.op-td .ac-clip {
  display: block;
  max-width: 260px;
}

.op-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 960px) {
  .op-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .op-grid {
    grid-template-columns: 1fr;
  }
}
</style>
