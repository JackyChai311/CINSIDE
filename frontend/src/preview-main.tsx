import React from "react";
import ReactDOM from "react-dom/client";
import ResultsPanel, { type ExtractSummaryItem } from "./components/ResultsPanel";
import type { PickedMark, FieldMapping } from "./types";
import "./index.css";

// 仅用于本地视觉校验的临时脚手架：只由 preview.html 引用，main.tsx 与 index.html 不引用它，故不进入打包产物。
// 校验结束后可安全删除本文件与 frontend/preview.html。
const marks: PickedMark[] = [
  { id: "p1", order: 1, side: "left", source: "web", selector: "#search", label: "搜索按钮", workflow: "review", createdAt: 1 },
  { id: "p2", order: 2, side: "left", source: "web", selector: "#go", label: "开始查询", workflow: "review", createdAt: 2 },
];
const mid: PickedMark[] = [
  { id: "m1", order: 3, side: "right", source: "web", selector: "#next", label: "NEXT 下一步", workflow: "review", createdAt: 3 },
];
const post: PickedMark[] = [
  { id: "q1", order: 4, side: "right", source: "web", selector: "#save", label: "保存并返回列表", workflow: "review", createdAt: 4 },
];
const mappings: FieldMapping[] = [
  { left_source: "excel", left_field: "申请人姓名", right_selector: "#name", right_label: "姓名输入框", web_side: "right" },
  { left_source: "excel", left_field: "证件号码", right_selector: "#idno", right_label: "证件号码", web_side: "right" },
  { left_source: "excel", left_field: "手机号", right_selector: "#phone", right_label: "联系电话", web_side: "right" },
];
const extracts: ExtractSummaryItem[] = [
  { id: "e1", kind: "doc", name: "本地文件", detail: "身份证正面.jpg（OCR 待识别）", saved: false, ts: 10 },
  { id: "e2", kind: "custom", name: "自定义文本", detail: "审核结论：通过", saved: false, ts: 11 },
  { id: "e3", kind: "widget", name: "选项控件", detail: "学历：本科", saved: true, ts: 12 },
];

const hovered: { mark: PickedMark | null } = { mark: null };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="w-[430px] bg-white p-2">
    <div id="hover-log" className="mb-2 text-[11px] text-slate-700">hover: none</div>
    <ResultsPanel
      comparisons={[]}
      resultPresent={false}
      report={null}
      shots={[]}
      running={false}
      newLoopSignal={1}
      focusPanel="field"
      preClickMarks={marks}
      processClickMarks={mid}
      postClickMarks={post}
      reviewMappings={mappings}
      extractStepSummary={extracts}
      onPreviewMark={() => {}}
      onHoverMark={(m) => {
        hovered.mark = m;
        const el = document.getElementById("hover-log");
        if (el) el.textContent = m ? `hover: ${m.label || m.selector} (side=${m.side})` : "hover: none";
        (window as any).__lastHover = m;
      }}
      onRunSteps={() => {}}
      onRemoveMark={() => {}}
      onRemoveMapping={() => {}}
      onRemoveExtractStep={() => {}}
    />
  </div>
);
