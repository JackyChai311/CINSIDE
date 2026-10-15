/**
 * skills 单元测试。
 *
 * 纯函数（镜像 / 帧对齐 / 默认图标）直接测试；
 * 其余函数走 localStorage，node 环境没有该 API，因此注入一个极小的内存版 Storage
 * （只原样存字符串，不含业务逻辑），用来验证模块自身的真实行为。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FieldMapping, PaneSnapshot, PickedMark, WorkflowTemplate } from "../types";
import {
  mirrorTemplateSides,
  frameAlignedTemplate,
  getDefaultIcons,
  loadSkills,
  saveSkill,
  deleteSkill,
  updateSkillMeta,
  setSkillsGroup,
  listSkillGroups,
  getSkillById,
  importSkill,
  hasSkill,
} from "./skills";

const SKILLS_KEY = "cinside_skills";

/** 取出断言用值，避免非空断言 */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("期望值存在，但为 null/undefined");
  return value;
}

/** 极简内存 Storage：仅原样保存字符串 */
function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
  };
}

function mark(over: Partial<PickedMark> = {}): PickedMark {
  return {
    id: "m0",
    order: 1,
    side: "right",
    source: "web",
    selector: "#m0",
    label: "标记",
    workflow: "data-source",
    createdAt: 0,
    ...over,
  } as PickedMark;
}

function mapping(over: Partial<FieldMapping> = {}): FieldMapping {
  return {
    right_selector: "#f",
    left_source: "excel",
    left_field: "name",
    ...over,
  } as FieldMapping;
}

function template(over: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: "tpl-1",
    name: "模板",
    createdAt: 0,
    mode: "review",
    dataSourceMarks: [],
    reviewMarks: [],
    entryMarks: [],
    hasSearchSteps: false,
    hasSubmitStep: false,
    ...over,
  } as WorkflowTemplate;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mirrorTemplateSides", () => {
  it("三个阶段 marks 的 side 全部左右互换，原模板与元素对象不被修改", () => {
    const t = template({
      dataSourceMarks: [mark({ id: "d1", side: "left" })],
      reviewMarks: [mark({ id: "r1", side: "right", workflow: "review" })],
      entryMarks: [mark({ id: "e1", side: "left", workflow: "entry" })],
    });

    const m = mirrorTemplateSides(t);

    expect(m.dataSourceMarks[0].side).toBe("right");
    expect(m.reviewMarks[0].side).toBe("left");
    expect(m.entryMarks[0].side).toBe("right");

    expect(t.dataSourceMarks[0].side).toBe("left");
    expect(m.dataSourceMarks[0]).not.toBe(t.dataSourceMarks[0]);
    expect(m.dataSourceMarks[0].id).toBe("d1");
    expect(m.dataSourceMarks[0].label).toBe("标记");
  });

  it("mappings 的 web_side：只有 left 变 right，其余（含 undefined）一律变 left", () => {
    const t = template({
      mappings: [mapping({ right_selector: "#a", web_side: "left" }), mapping({ right_selector: "#b" })],
    });

    const m = mirrorTemplateSides(t);

    expect(must(m.mappings)[0].web_side).toBe("right");
    expect(must(m.mappings)[1].web_side).toBe("left");
    expect(m.mappings).not.toBe(t.mappings);
    expect(t.mappings?.[1].web_side).toBeUndefined();
  });

  it("mappings 未设置时仍为 undefined", () => {
    expect(mirrorTemplateSides(template({})).mappings).toBeUndefined();
  });

  it("siteOrigins 左右互换；未设置时保持 undefined", () => {
    const withBoth = mirrorTemplateSides(template({ siteOrigins: { left: "L", right: "R" } }));
    expect(withBoth.siteOrigins).toEqual({ left: "R", right: "L" });
    expect(mirrorTemplateSides(template({})).siteOrigins).toBeUndefined();
  });

  it("siteOrigins 只有一侧时另一侧为 undefined", () => {
    const m = mirrorTemplateSides(template({ siteOrigins: { left: "L" } }));
    expect(m.siteOrigins).toEqual({ left: undefined, right: "L" });
  });

  it("groupPanes 左右互换；未设置时保持 undefined", () => {
    const left: PaneSnapshot = { kind: "web", label: "a.edu", origin: "https://a.edu" };
    const right: PaneSnapshot = { kind: "excel", label: "名单.xlsx" };

    const m = mirrorTemplateSides(template({ groupPanes: { left, right } }));
    expect(m.groupPanes).toEqual({ left: right, right: left });
    expect(mirrorTemplateSides(template({})).groupPanes).toBeUndefined();
  });

  it("镜像两次回到原状，其它字段保持不变", () => {
    const t = template({ id: "t9", name: "名字", description: "说明", flipped: true, siteOrigins: { left: "L", right: "R" } });
    const twice = mirrorTemplateSides(mirrorTemplateSides(t));

    expect(twice.id).toBe("t9");
    expect(twice.name).toBe("名字");
    expect(twice.description).toBe("说明");
    expect(twice.flipped).toBe(true);
    expect(twice.siteOrigins).toEqual({ left: "L", right: "R" });
  });
});

describe("frameAlignedTemplate", () => {
  it("模板 flipped 标记与会话状态一致时原样返回同一对象", () => {
    const flippedTpl = template({ flipped: true });
    expect(frameAlignedTemplate(flippedTpl, true)).toBe(flippedTpl);

    const unsetTpl = template({});
    expect(frameAlignedTemplate(unsetTpl, false)).toBe(unsetTpl);
  });

  it("不一致时返回镜像后的模板（不改动原模板）", () => {
    const t = template({ flipped: true, dataSourceMarks: [mark({ id: "d1", side: "left" })] });
    const out = frameAlignedTemplate(t, false);

    expect(out).not.toBe(t);
    expect(out.dataSourceMarks[0].side).toBe("right");
    expect(t.dataSourceMarks[0].side).toBe("left");
    expect(out.flipped).toBe(true);
  });

  it("flipped 未设置时按 false 处理", () => {
    const t = template({ dataSourceMarks: [mark({ id: "d1", side: "left" })] });
    expect(frameAlignedTemplate(t, false)).toBe(t);
    expect(frameAlignedTemplate(t, true).dataSourceMarks[0].side).toBe("right");
  });
});

describe("getDefaultIcons", () => {
  it("返回 16 个互不相同的非空图标，首尾与常量一致", () => {
    const icons = getDefaultIcons();
    expect(icons).toHaveLength(16);
    expect(icons[0]).toBe("🔍");
    expect(icons[15]).toBe("📌");
    expect(icons.every((i) => typeof i === "string" && i.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(16);
  });
});

describe("loadSkills", () => {
  it("空存储返回空数组", () => {
    expect(loadSkills()).toEqual([]);
    expect(localStorage.getItem(SKILLS_KEY)).toBeNull();
  });

  it("JSON 损坏或不是数组时返回空数组", () => {
    localStorage.setItem(SKILLS_KEY, "{not json");
    expect(loadSkills()).toEqual([]);

    localStorage.setItem(SKILLS_KEY, JSON.stringify({ id: "x" }));
    expect(loadSkills()).toEqual([]);

    localStorage.setItem(SKILLS_KEY, JSON.stringify("abc"));
    expect(loadSkills()).toEqual([]);
  });

  it("正常读取已保存的数组", () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([{ id: "a", name: "A" }]));
    expect(loadSkills().map((s) => s.id)).toEqual(["a"]);
  });
});

describe("saveSkill / deleteSkill / getSkillById / hasSkill / importSkill", () => {
  it("saveSkill 新增时插到最前面，并返回带 updatedAt 的副本", () => {
    const a = saveSkill(template({ id: "a", name: "A" }));
    expect(a.id).toBe("a");
    expect(a.updatedAt).toBeTypeOf("number");

    saveSkill(template({ id: "b", name: "B" }));
    expect(loadSkills().map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("saveSkill 同 id 覆盖原位置，不产生重复", () => {
    saveSkill(template({ id: "a", name: "A" }));
    saveSkill(template({ id: "b", name: "B" }));

    const updated = saveSkill(template({ id: "a", name: "A2" }));

    expect(updated.name).toBe("A2");
    expect(loadSkills().map((s) => s.id)).toEqual(["b", "a"]);
    expect(loadSkills().filter((s) => s.id === "a")).toHaveLength(1);
    expect(must(getSkillById("a")).name).toBe("A2");
  });

  it("deleteSkill 按 id 删除，不存在的 id 不报错", () => {
    saveSkill(template({ id: "a" }));
    saveSkill(template({ id: "b" }));

    deleteSkill("a");
    expect(loadSkills().map((s) => s.id)).toEqual(["b"]);

    expect(() => deleteSkill("nope")).not.toThrow();
    expect(loadSkills().map((s) => s.id)).toEqual(["b"]);
  });

  it("getSkillById 找不到返回 null，hasSkill 返回布尔", () => {
    saveSkill(template({ id: "a", name: "A" }));
    expect(must(getSkillById("a")).name).toBe("A");
    expect(getSkillById("nope")).toBeNull();
    expect(hasSkill("a")).toBe(true);
    expect(hasSkill("nope")).toBe(false);
  });

  it("importSkill 等价于 saveSkill", () => {
    const saved = importSkill(template({ id: "im", name: "导入" }));
    expect(saved.id).toBe("im");
    expect(saved.updatedAt).toBeTypeOf("number");
    expect(hasSkill("im")).toBe(true);
    expect(must(getSkillById("im")).name).toBe("导入");
  });
});

describe("updateSkillMeta", () => {
  it("更新基础字段并刷新 updatedAt", () => {
    saveSkill(template({ id: "a", name: "A", updatedAt: 1 }));

    updateSkillMeta("a", { name: "A2", description: "说明", icon: "📌" });

    const s = must(getSkillById("a"));
    expect(s.name).toBe("A2");
    expect(s.description).toBe("说明");
    expect(s.icon).toBe("📌");
    expect(s.updatedAt).toBeGreaterThan(1);
  });

  it("iconImage：字符串写入，null 删除", () => {
    saveSkill(template({ id: "a", iconImage: "data:image/png;base64,AAA" }));

    updateSkillMeta("a", { iconImage: null });
    expect(must(getSkillById("a")).iconImage).toBeUndefined();
    expect("iconImage" in must(getSkillById("a"))).toBe(false);

    updateSkillMeta("a", { iconImage: "data:image/png;base64,BBB" });
    expect(must(getSkillById("a")).iconImage).toBe("data:image/png;base64,BBB");
  });

  it("group：字符串 trim 后写入，null 删除，空白串不改动", () => {
    saveSkill(template({ id: "a", group: "旧组" }));

    updateSkillMeta("a", { group: "  新组  " });
    expect(must(getSkillById("a")).group).toBe("新组");

    updateSkillMeta("a", { group: "   " });
    expect(must(getSkillById("a")).group).toBe("新组");

    updateSkillMeta("a", { group: null });
    expect(must(getSkillById("a")).group).toBeUndefined();
    expect("group" in must(getSkillById("a"))).toBe(false);
  });

  it("未传 iconImage / group 时不会误删已有值", () => {
    saveSkill(template({ id: "a", iconImage: "img", group: "G" }));

    updateSkillMeta("a", { name: "A2" });

    const s = must(getSkillById("a"));
    expect(s.name).toBe("A2");
    expect(s.iconImage).toBe("img");
    expect(s.group).toBe("G");
  });

  it("id 不存在时静默无操作", () => {
    saveSkill(template({ id: "a", name: "A" }));
    expect(() => updateSkillMeta("nope", { name: "X" })).not.toThrow();
    expect(loadSkills().map((s) => s.name)).toEqual(["A"]);
  });
});

describe("setSkillsGroup", () => {
  it("命中的模板加组（trim），未命中的不动", () => {
    saveSkill(template({ id: "a" }));
    saveSkill(template({ id: "b" }));
    saveSkill(template({ id: "c", group: "C组" }));

    setSkillsGroup(["a", "b"], "  组1  ");

    const byId = new Map(loadSkills().map((s) => [s.id, s]));
    expect(byId.get("a")?.group).toBe("组1");
    expect(byId.get("b")?.group).toBe("组1");
    expect(byId.get("c")?.group).toBe("C组");
  });

  it("group 为 null 时移出分组", () => {
    saveSkill(template({ id: "a", group: "G" }));
    setSkillsGroup(["a"], null);
    expect(must(getSkillById("a")).group).toBeUndefined();
    expect("group" in must(getSkillById("a"))).toBe(false);
  });

  it("group 为空白串时不改动", () => {
    saveSkill(template({ id: "a", group: "G" }));
    setSkillsGroup(["a"], "   ");
    expect(must(getSkillById("a")).group).toBe("G");
  });

  it("ids 含不存在的 id 时不报错", () => {
    saveSkill(template({ id: "a" }));
    expect(() => setSkillsGroup(["a", "nope"], "组2")).not.toThrow();
    expect(must(getSkillById("a")).group).toBe("组2");
  });
});

describe("listSkillGroups", () => {
  it("去重、忽略空白分组并按名称排序", () => {
    saveSkill(template({ id: "a", group: "beta" }));
    saveSkill(template({ id: "b", group: "alpha" }));
    saveSkill(template({ id: "c", group: "  beta  " }));
    saveSkill(template({ id: "d" }));
    saveSkill(template({ id: "e", group: "   " }));

    expect(listSkillGroups()).toEqual(["alpha", "beta"]);
  });

  it("没有任何分组时返回空数组", () => {
    saveSkill(template({ id: "a" }));
    expect(listSkillGroups()).toEqual([]);
  });
});
