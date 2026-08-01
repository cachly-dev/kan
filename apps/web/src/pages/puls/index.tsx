import type { NextPageWithLayout } from "~/pages/_app";
import { getDashboardLayout } from "~/components/Dashboard";

/**
 * cachly: Mothership-Puls als nativer Kan-Menuepunkt.
 * Die UI kommt session-gesichert ueber /api/mothership/puls (Proxy zu hookd);
 * relative Fetches der eingebetteten Seite (puls/data, puls/ask, wissen)
 * loesen automatisch unter /api/mothership/ auf.
 */
const PulsPage: NextPageWithLayout = () => {
  return (
    <div className="h-full w-full">
      <iframe
        src="/api/mothership/puls"
        title="Mothership Puls"
        className="h-full w-full border-0"
      />
    </div>
  );
};

PulsPage.getLayout = (page) => getDashboardLayout(page);

export default PulsPage;
