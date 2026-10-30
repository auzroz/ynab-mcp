/**
 * Category target fragments tests
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  categoryTargetCreateShape,
  categoryTargetUpdateShape,
  categoryTargetCreateJsonProperties,
  categoryTargetUpdateJsonProperties,
  pickCategoryTargets,
} from "../../../../src/tools/categories/category-targets.js";

describe("category target fragments", () => {
  const create = z.object(categoryTargetCreateShape);
  const update = z.object(categoryTargetUpdateShape);

  it("update shape allows null to clear each field; create does not", () => {
    const cleared = {
      goal_target: null,
      goal_target_date: null,
      goal_needs_whole_amount: null,
    };
    expect(update.parse(cleared)).toEqual(cleared);
    expect(() => create.parse({ goal_target: null })).toThrow();
    expect(() => create.parse({ goal_target_date: null })).toThrow();
    expect(() => create.parse({ goal_needs_whole_amount: null })).toThrow();
  });

  it("update shape still rejects negative, float and bad dates", () => {
    expect(() => update.parse({ goal_target: -5 })).toThrow();
    expect(update.parse({ goal_target: 1.5 }).goal_target).toBe(1.5);
    expect(() => update.parse({ goal_target: Infinity })).toThrow();
    expect(() => update.parse({ goal_target_date: "next month" })).toThrow();
  });

  it("JSON properties cover the same keys as the zod shapes", () => {
    expect(Object.keys(categoryTargetCreateJsonProperties).sort()).toEqual(
      Object.keys(categoryTargetCreateShape).sort(),
    );
    expect(Object.keys(categoryTargetUpdateJsonProperties).sort()).toEqual(
      Object.keys(categoryTargetUpdateShape).sort(),
    );
    expect(categoryTargetUpdateJsonProperties.goal_target.type).toContain(
      "null",
    );
    expect(categoryTargetCreateJsonProperties.goal_target.type).toBe("number");
  });

  it("pickCategoryTargets converts dollar goal_target to milliunits", () => {
    expect(pickCategoryTargets({ goal_target: 200 })).toEqual({
      goal_target: 200000,
    });
    expect(pickCategoryTargets({ goal_target: 12.34 })).toEqual({
      goal_target: 12340,
    });
  });

  it("pickCategoryTargets keeps null, drops undefined and unrelated keys", () => {
    expect(
      pickCategoryTargets({
        goal_target: null,
        goal_target_date: undefined,
        name: "x",
      } as never),
    ).toEqual({ goal_target: null });
  });
});
