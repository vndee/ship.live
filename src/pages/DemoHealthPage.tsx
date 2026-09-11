import type { ComponentProps } from "react";
import { Activity } from "lucide-react";
import { PublicHealthList } from "../components/PublicHealthList";

/** The signed-out Service Health page: fictional services, read only. */
export function DemoHealthPage({
  services,
  now,
}: ComponentProps<typeof PublicHealthList>) {
  return (
    <section className="service-health" aria-labelledby="service-health-title">
      <div className="section-heading health-heading">
        <h2 id="service-health-title">
          <Activity size={19} /> Service Health{" "}
          <span className="section-count">{services.length}</span>
        </h2>
      </div>
      <p className="health-intro">
        Sample services with fictional checks. Sign in and connect a team to
        monitor your own endpoints.
      </p>
      <PublicHealthList services={services} now={now} />
    </section>
  );
}
