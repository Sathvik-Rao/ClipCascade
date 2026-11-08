import { describe, expect, it } from "vitest";
import { extractCsrfToken } from "../src/background/auth";

describe("extractCsrfToken", () => {
  it("finds Spring's hidden field regardless of attribute order", () => {
    expect(extractCsrfToken('<form><input type="hidden" name="_csrf" value="abc-123"/></form>')).toBe("abc-123");
    expect(extractCsrfToken("<INPUT value='tok' name='_csrf' type='hidden'>")).toBe("tok");
  });

  it("ignores other inputs", () => {
    expect(extractCsrfToken('<input name="username" value="x"><input name="_csrf" value="y">')).toBe("y");
    expect(extractCsrfToken('<input name="username" value="x">')).toBeUndefined();
  });
});
