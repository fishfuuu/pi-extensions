/**
 * pi-side-panel - Pi extension entry point.
 *
 * Registers `/side`: a read-only side thread that lives in a panel you can keep
 * chatting in. See driver.ts for the turn loop and the two local fixes, and
 * VENDOR.md for what `vendor/` is and how to re-sync it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSideCommand } from "./driver.js";

export default function (pi: ExtensionAPI): void {
	registerSideCommand(pi);
}
