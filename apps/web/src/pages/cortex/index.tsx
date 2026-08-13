import type { NextPageWithLayout } from "~/pages/_app";
import { getDashboardLayout } from "~/components/Dashboard";

/**
 * cachly: Mothership-Cortex als nativer Kan-Menuepunkt.
 * Der Cortex ist die Wissens-Ansicht des Mothership als zoombares Netz;
 * die UI kommt session-gesichert ueber /api/mothership/karte (Proxy zu hookd).
 */
const CortexPage: NextPageWithLayout = () => {
  return (
    <div className="h-full w-full">
      <iframe
        src="/api/mothership/karte"
        title="Mothership Cortex"
        className="h-full w-full border-0"
      />
    </div>
  );
};

CortexPage.getLayout = (page) => getDashboardLayout(page);

export default CortexPage;
