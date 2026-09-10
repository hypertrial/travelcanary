import { useState } from "react";
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay, Popover } from "react-aria-components";
import { installInstructions, type InstallPlatform } from "@/lib/install-presentation";
import { publicLabels, publicSymbols } from "@/lib/ui-presentation";
import { UiIcon } from "./UiIcon";
import styles from "./AppMenu.module.css";

function MenuBody({ platform, installed, selfHosted, instanceHealth, restrictedSourcesActive, onClose }: {
  platform: InstallPlatform; installed: boolean; selfHosted: boolean; instanceHealth: string | null;
  restrictedSourcesActive: boolean; onClose?: () => void;
}) {
  const [section, setSection] = useState<"menu" | "key" | "install" | "instance" | "about">("menu");
  if (section === "key") return <div className={styles.detail}>
    <button type="button" className={styles.back} onClick={() => setSection("menu")}>‹ Back</button>
    <Heading slot="title">Map key</Heading>
    <p>Counts are destinations, not incidents. Search and Alerts still reach every supported place.</p>
    <ul className={styles.keyList}>{(["NORMAL", "ELEVATED", "HIGH", "SEVERE", "UNKNOWN"] as const).map((level) => <li key={level}><span data-level={level}>{level === "NORMAL" ? <UiIcon name="search" /> : publicSymbols[level]}</span><strong>{publicLabels[level]}</strong></li>)}</ul>
  </div>;
  if (section === "install") return <div className={styles.detail}>
    <button type="button" className={styles.back} onClick={() => setSection("menu")}>‹ Back</button>
    <Heading slot="title">{installed ? "TravelCanary is installed" : "Install TravelCanary"}</Heading>
    <p>{installed ? "You are using the standalone home-screen app." : installInstructions(platform)}</p>
    <p className={styles.note}>Installation does not make live alerts available offline. TravelCanary still needs a connection to refresh.</p>
  </div>;
  if (section === "about") return <div className={styles.detail}>
    <button type="button" className={styles.back} onClick={() => setSection("menu")}>‹ Back</button>
    <Heading slot="title">About TravelCanary</Heading>
    <p>TravelCanary is a current and next-24-hours travel aid for source-backed hazards across Europe.</p>
    <p className={styles.note}>It is not an emergency service or a general safety score. Official local instructions always take precedence.</p>
  </div>;
  if (section === "instance") return <div className={styles.detail}>
    <button type="button" className={styles.back} onClick={() => setSection("menu")}>‹ Back</button>
    <Heading slot="title">Self-hosted instance</Heading>
    <p>Service status: <strong>{instanceHealth || "checking"}</strong>. Data stays in the operator&apos;s local SQLite database unless they explicitly expose this site.</p>
    <p className={styles.note}>{restrictedSourcesActive
      ? "Restricted data is present or collection is enabled under noncommercial source terms; original terms still apply."
      : "Restricted sources are disabled. Open reviewed sources can collect without that opt-in."}</p>
  </div>;
  return <div className={styles.menuBody}>
    <div className={styles.menuHeading}><span><UiIcon name="menu" /></span><div><Heading slot="title">TravelCanary</Heading><p>Map help and app information</p></div></div>
    <div className={styles.menuItems}>
      <button type="button" onClick={() => setSection("key")}><UiIcon name="map" /><span><strong>Map key</strong><small>Alert symbols and coverage tint</small></span><UiIcon name="chevron" /></button>
      <button type="button" onClick={() => setSection("install")}><UiIcon name="install" /><span><strong>{installed ? "Installed app" : "Install TravelCanary"}</strong><small>{installed ? "Standalone mode is active" : "Add it to your home screen"}</small></span><UiIcon name="chevron" /></button>
      {selfHosted && <button type="button" onClick={() => setSection("instance")}><UiIcon name="coverage" /><span><strong>Self-hosted instance</strong><small>{restrictedSourcesActive ? "Restricted data is active" : `Service ${instanceHealth || "checking"}`}</small></span><UiIcon name="chevron" /></button>}
      <button type="button" onClick={() => setSection("about")}><UiIcon name="coverage" /><span><strong>About and limitations</strong><small>What this app can and cannot tell you</small></span><UiIcon name="chevron" /></button>
    </div>
    {onClose && <Button slot="close" className={styles.done} onPress={onClose}>Done</Button>}
  </div>;
}

export function AppMenu({ compact, platform, installed, selfHosted = false, instanceHealth = null, restrictedSourcesActive = false }: {
  compact: boolean; platform: InstallPlatform; installed: boolean; selfHosted?: boolean;
  instanceHealth?: string | null; restrictedSourcesActive?: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const trigger = <Button className={styles.trigger} aria-label="Open app menu" onPress={() => compact && setMobileOpen(true)}><UiIcon name="menu" /></Button>;
  const body = { platform, installed, selfHosted, instanceHealth, restrictedSourcesActive };
  if (compact) return <>{trigger}<ModalOverlay isOpen={mobileOpen} onOpenChange={setMobileOpen} isDismissable className={styles.overlay}><Modal className={styles.modal}><Dialog className={styles.dialog}>{({ close }) => <MenuBody {...body} onClose={close} />}</Dialog></Modal></ModalOverlay></>;
  return <DialogTrigger>{trigger}<Popover isNonModal placement="bottom end" offset={8} className={styles.popover}><Dialog className={styles.dialog}><MenuBody {...body} /></Dialog></Popover></DialogTrigger>;
}
