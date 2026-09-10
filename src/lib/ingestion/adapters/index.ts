import { CemsAdapter } from "./cems";
import { EffisAdapter } from "./effis";
import { MeteoAlarmAdapter } from "./meteoalarm";
import { UsgsAdapter } from "./usgs";
import { EmscAdapter } from "./emsc";
import { GdacsAdapter } from "./gdacs";
import { EeaAdapter } from "./eea";
import { NationalCivilAlertsAdapter } from "./national-civil-alerts";
import { FirmsAdapter } from "./firms";
import { EuregioAvalancheAdapter, SlfAvalancheAdapter } from "./avalanche";
import { FoenFloodAdapter } from "./foen";
import { GfmAdapter } from "./satellite";
import { VigicruesAdapter } from "./vigicrues";
import { EhydFloodAdapter } from "./ehyd";
import { EonetAdapter } from "./eonet";
import { EdoDroughtAdapter } from "./edo";
import { FcdoTravelAdviceAdapter } from "./fcdo";
import { GdeltAdapter } from "./gdelt";

export const sourceAdapters = [
  new MeteoAlarmAdapter(), new UsgsAdapter(), new EmscAdapter(), new CemsAdapter(), new GdacsAdapter(),
  new EffisAdapter(), new EeaAdapter(), new FirmsAdapter(), new FoenFloodAdapter(),
  new SlfAvalancheAdapter(), new EuregioAvalancheAdapter(), new VigicruesAdapter(), new EhydFloodAdapter(), new GfmAdapter(),
  new NationalCivilAlertsAdapter(),
  new EonetAdapter(), new EdoDroughtAdapter(), new FcdoTravelAdviceAdapter(),
  new GdeltAdapter(),
];
