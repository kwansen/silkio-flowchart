import { describe, expect, it } from "vitest";
import type { SelectionCapability } from "@silker/core";
import { FlowEdge } from "../src/FlowEdge";
import { Shape } from "../src/Shape";
import { multiBounds, selEdge, selShape, selShapes } from "../src/selection";

// 构造绕过构造器的 Shape/FlowEdge 桩：Object.create 保留原型链使 instanceof
// 成立，手工补上派生函数读取的字段（node 环境无需 canvas/渲染上下文）
function fakeShape(x: number, y: number, width = 100, height = 60): Shape {
  const s = Object.create(Shape.prototype) as Shape;
  s.x = x;
  s.y = y;
  s.width = width;
  s.height = height;
  return s;
}

function fakeEdge(): FlowEdge {
  return Object.create(FlowEdge.prototype) as FlowEdge;
}

function fakeSel(
  items: Array<Shape | FlowEdge>,
): SelectionCapability<Shape | FlowEdge> {
  return { items } as unknown as SelectionCapability<Shape | FlowEdge>;
}

describe("selShape", () => {
  it("单个形状选中时返回该形状", () => {
    const shape = fakeShape(0, 0);
    expect(selShape(fakeSel([shape]))).toBe(shape);
  });

  it("选中连线时返回 null", () => {
    expect(selShape(fakeSel([fakeEdge()]))).toBeNull();
  });

  it("多选组合与无选中时返回 null", () => {
    const s1 = fakeShape(0, 0);
    const s2 = fakeShape(200, 0);
    expect(selShape(fakeSel([s1, s2]))).toBeNull();
    expect(selShape(fakeSel([]))).toBeNull();
  });
});

describe("selEdge", () => {
  it("单条连线选中时返回该连线", () => {
    const edge = fakeEdge();
    expect(selEdge(fakeSel([edge]))).toBe(edge);
  });

  it("选中形状/多选/无选中时返回 null", () => {
    const shape = fakeShape(0, 0);
    expect(selEdge(fakeSel([shape]))).toBeNull();
    expect(selEdge(fakeSel([fakeEdge(), fakeEdge()]))).toBeNull();
    expect(selEdge(fakeSel([]))).toBeNull();
  });
});

describe("selShapes", () => {
  it("过滤掉连线，仅保留形状", () => {
    const s1 = fakeShape(0, 0);
    const s2 = fakeShape(200, 0);
    expect(selShapes(fakeSel([s1, fakeEdge(), s2]))).toEqual([s1, s2]);
  });

  it("单选形状返回单元素列表，选中连线/无选中返回空列表", () => {
    const shape = fakeShape(0, 0);
    expect(selShapes(fakeSel([shape]))).toEqual([shape]);
    expect(selShapes(fakeSel([fakeEdge()]))).toEqual([]);
    expect(selShapes(fakeSel([]))).toEqual([]);
  });
});

describe("multiBounds", () => {
  it("少于 2 个形状（无选中/单选形状/选中连线）时视为无组合", () => {
    expect(multiBounds(fakeSel([]))).toBeNull();
    expect(multiBounds(fakeSel([fakeShape(0, 0)]))).toBeNull();
    expect(multiBounds(fakeSel([fakeEdge()]))).toBeNull();
  });

  it("多选组合返回成员包围盒的并集", () => {
    const b = multiBounds(fakeSel([fakeShape(0, 0), fakeShape(100, 0)]));
    expect(b).toEqual({ x: 0, y: 0, width: 200, height: 60 });
  });

  it("并集只统计形状，连线不参与", () => {
    const b = multiBounds(fakeSel([fakeShape(0, 0), fakeEdge(), fakeShape(100, 0)]));
    expect(b).toEqual({ x: 0, y: 0, width: 200, height: 60 });
  });

  it("负坐标成员正确并入", () => {
    const b = multiBounds(fakeSel([fakeShape(-50, -30), fakeShape(100, 0)]));
    expect(b).toEqual({ x: -50, y: -30, width: 250, height: 90 });
  });
});
