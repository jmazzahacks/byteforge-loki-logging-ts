import { describe, it, expect } from "vitest";
import { sanitizeLabel, sanitizeLabels } from "../src/labels.js";

describe("sanitizeLabel", function () {
  it("should return a simple label unchanged", function () {
    expect(sanitizeLabel("app_name")).toBe("app_name");
  });

  it("should strip surrounding double quotes", function () {
    expect(sanitizeLabel('"my_label"')).toBe("my_label");
  });

  it("should strip surrounding single quotes", function () {
    expect(sanitizeLabel("'my_label'")).toBe("my_label");
  });

  it("should replace spaces with underscores", function () {
    expect(sanitizeLabel("my label")).toBe("my_label");
  });

  it("should replace dots with underscores", function () {
    expect(sanitizeLabel("my.label")).toBe("my_label");
  });

  it("should replace dashes with underscores", function () {
    expect(sanitizeLabel("my-label")).toBe("my_label");
  });

  it("should remove invalid characters", function () {
    expect(sanitizeLabel("my@label!")).toBe("mylabel");
  });

  it("should handle combined transformations", function () {
    expect(sanitizeLabel('"my app.log-level"')).toBe("my_app_log_level");
  });

  it("should handle empty string", function () {
    expect(sanitizeLabel("")).toBe("");
  });
});

describe("sanitizeLabels", function () {
  it("should sanitize both keys and values", function () {
    const input = { "app.name": "my-service", env: "prod" };
    const result = sanitizeLabels(input);
    expect(result).toEqual({ app_name: "my_service", env: "prod" });
  });

  it("should drop keys that become empty after sanitization", function () {
    const input = { "@@": "value", valid: "ok" };
    const result = sanitizeLabels(input);
    expect(result).toEqual({ valid: "ok" });
  });

  it("should handle empty input", function () {
    expect(sanitizeLabels({})).toEqual({});
  });
});
