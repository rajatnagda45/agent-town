// Functional workflow checks use the supported 2D view after office startup.
// Continuous 3D software rendering on CPU-only runners can starve browser input.
export async function prepareFunctionalOffice(page) {
  await page.bringToFront();
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector('[title="Switch office view"]');
      return document.querySelector(".office-stage--classic") || (toggle && !toggle.disabled);
    },
    { polling: 100 },
  );
  const toggle = await page.$('.office-stage--3d [title="Switch office view"]:not(:disabled)');
  if (toggle) {
    await toggle.click();
    await toggle.dispose();
  }
  await page.waitForSelector(".office-stage--classic");
}
