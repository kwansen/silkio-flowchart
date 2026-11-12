<script setup lang="ts">
// 文档切换器：标题按钮（打开列表）、新建按钮，以及
// 文档列表 dialog（排序 / 重命名 / 打开 / 删除）。画布 onChange 自动保存，
// 无需保存按钮与保存状态提示；状态与持久化由宿主组件负责。
import { computed, ref } from "vue";
import { DEFAULT_DOC_NAME, type FlowChartDoc } from "../lib/idb";
import Icon from "./Icon.vue";

const props = defineProps<{
  docs: FlowChartDoc[];
  currentId: string;
  docName: string;
}>();

const emit = defineEmits<{
  create: [];
  open: [id: string];
  remove: [id: string];
  rename: [name: string];
}>();

const dialogOpen = ref(false);
const sortKey = ref<"createdAt" | "updatedAt">("updatedAt");
const sortAsc = ref(false);
const sortedDocs = computed(() => {
  const arr = [...props.docs];
  arr.sort(
    (a, b) => (sortAsc.value ? 1 : -1) * (a[sortKey.value] - b[sortKey.value]),
  );
  return arr;
});

function toggleSort(key: "createdAt" | "updatedAt") {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = key;
    sortAsc.value = false;
  }
}

function selectDoc(id: string) {
  dialogOpen.value = false;
  emit("open", id);
}

function createDoc() {
  dialogOpen.value = false;
  emit("create");
}

function onRename(event: Event) {
  emit("rename", (event.target as HTMLInputElement).value);
}

function onRenameEnter(event: KeyboardEvent) {
  (event.target as HTMLInputElement).blur();
}

function formatTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
</script>

<template>
  <!-- 文档切换器：标题 + 新建，共用一个悬浮底座 -->
  <div
    class="absolute top-4 left-4 z-10 flex items-center gap-0.5 rounded-[10px] bg-white p-1 shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
  >
    <button
      id="docs-btn"
      class="flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 hover:bg-gray-100"
      title="流程图列表"
      aria-label="流程图列表"
      @click="dialogOpen = true"
    >
      <Icon name="i-file" class="text-violet-500" />
      <span class="max-w-40 truncate text-xs text-gray-800">
        {{ docName || DEFAULT_DOC_NAME }}
      </span>
      <Icon name="i-chevron-down" size="h-3 w-3" class="text-gray-400" />
    </button>
    <button
      id="new-doc-btn"
      class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-gray-800 hover:bg-gray-100"
      title="新建流程图"
      aria-label="新建流程图"
      @click="createDoc"
    >
      <Icon name="i-plus" />
    </button>
  </div>

  <!-- 文档 dialog：遮罩点击关闭，列表按创建/更新时间排序，点击条目切换流程图 -->
  <Teleport to="body">
    <div
      v-if="dialogOpen"
      id="docs-dialog"
      class="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4"
      @click.self="dialogOpen = false"
    >
      <div
        class="flex max-h-[70vh] w-88 flex-col rounded-xl bg-white p-4 shadow-[0_8px_32px_rgba(0,0,0,0.2)]"
        role="dialog"
        aria-label="流程图列表"
      >
        <div class="mb-3 flex items-center gap-2">
          <span class="flex-1 text-sm font-medium text-gray-800">我的流程图</span>
          <button
            class="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            title="关闭"
            aria-label="关闭"
            @click="dialogOpen = false"
          >
            <Icon name="i-close" size="h-3.5 w-3.5" />
          </button>
        </div>

        <!-- 当前文档重命名：失焦或回车提交，与数据一起自动落盘 -->
        <label class="mb-3 flex items-center gap-2 text-[11px] text-gray-500">
          <span class="shrink-0">当前名称</span>
          <input
            id="doc-name-input"
            class="h-7 min-w-0 flex-1 rounded-md border border-gray-200 px-2 text-xs text-gray-800 outline-none focus:border-violet-400"
            type="text"
            :value="docName"
            :placeholder="DEFAULT_DOC_NAME"
            @change="onRename"
            @keydown.enter="onRenameEnter"
          />
        </label>

        <!-- 排序：创建时间 / 更新时间，点击切换升降序 -->
        <div class="mb-2 flex items-center gap-2">
          <button
            v-for="key in ['createdAt', 'updatedAt'] as const"
            :key="key"
            class="flex h-6 cursor-pointer items-center gap-0.5 rounded-md px-2 text-[11px]"
            :class="
              sortKey === key
                ? 'bg-[#ede9fe] font-medium text-violet-700'
                : 'text-gray-500 hover:bg-gray-100'
            "
            @click="toggleSort(key)"
          >
            {{ key === "createdAt" ? "创建时间" : "更新时间" }}
            <span v-if="sortKey === key" class="text-[9px]">{{
              sortAsc ? "↑" : "↓"
            }}</span>
          </button>
        </div>

        <!-- 流程图列表 -->
        <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          <div
            v-for="d in sortedDocs"
            :key="d.id"
            :data-doc-id="d.id"
            class="group/row flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 hover:bg-gray-100"
            :class="{ 'bg-[#ede9fe]': d.id === currentId }"
            @click="selectDoc(d.id)"
          >
            <Icon name="i-file" class="text-gray-400" />
            <div class="min-w-0 flex-1">
              <div
                class="truncate text-xs"
                :class="
                  d.id === currentId
                    ? 'font-medium text-violet-700'
                    : 'text-gray-800'
                "
              >
                {{ d.name }}
              </div>
              <div class="text-[10px] text-gray-400">
                创建于 {{ formatTime(d.createdAt) }} · 更新于
                {{ formatTime(d.updatedAt) }}
              </div>
            </div>
            <button
              class="hidden h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-gray-400 hover:text-red-500 group-hover/row:flex"
              title="删除流程图"
              aria-label="删除流程图"
              @click.stop="emit('remove', d.id)"
            >
              <Icon name="i-trash" size="h-3.5 w-3.5" />
            </button>
          </div>
          <div
            v-if="!sortedDocs.length"
            class="py-8 text-center text-xs text-gray-400"
          >
            还没有流程图，点击左上角「+」新建
          </div>
        </div>

        <button
          class="mt-3 flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md bg-violet-50 text-xs text-violet-700 hover:bg-violet-100"
          @click="createDoc"
        >
          <Icon name="i-plus" size="h-3.5 w-3.5" />
          新建流程图
        </button>
      </div>
    </div>
  </Teleport>
</template>
