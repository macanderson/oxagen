// @vitest-environment jsdom
// The provider hands the zone to next-intl and keeps the tz cookie aligned so
// the next request's server formatters read the same value.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IntlProvider } from "@/test/intl";
import { timeZoneCookieString } from "@/shared/time-zone-cookie";
import { TimeZoneProvider } from "./time-zone-provider";

afterEach(() => {
  cleanup();
  document.cookie = "tz=; Max-Age=0; Path=/";
});

describe("TimeZoneProvider", () => {
  it("writes the tz cookie for the zone it was given", async () => {
    render(
      <IntlProvider>
        <TimeZoneProvider timeZone="Asia/Tokyo">
          <span>ok</span>
        </TimeZoneProvider>
      </IntlProvider>,
    );
    await waitFor(() => {
      expect(document.cookie).toContain(
        timeZoneCookieString("Asia/Tokyo", false).split(";")[0],
      );
    });
  });
});
