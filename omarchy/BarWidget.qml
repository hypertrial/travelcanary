import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "hypertrial.travelcanary"

  readonly property var canaryService: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  readonly property var summary: canaryService ? canaryService.summary : null
  readonly property string strongest: canaryService && canaryService.available ? Model.strongestState(summary) : "UNAVAILABLE"
  readonly property int attention: Model.attentionCount(summary)
  readonly property string pillText: Model.stateLabel(strongest) + (attention > 0 ? " " + attention : "")

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("canaryService" in target) target.canaryService = root.canaryService
    configureService()
  }

  function configureService() {
    if (!canaryService || typeof canaryService.configure !== "function") return
    canaryService.configure(setting("serviceUrl", "http://127.0.0.1:3000"), setting("refreshIntervalSec", 300))
  }

  function refresh() {
    if (canaryService && typeof canaryService.refresh === "function") canaryService.refresh()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function open() { if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey() }
  function close() { if (panelLoader.item && panelLoader.item.close) panelLoader.item.close() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  onCanaryServiceChanged: injectPanel()
  Component.onCompleted: Qt.callLater(injectPanel)

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    active: root.strongest === "SEVERE" || root.strongest === "HIGH" || root.strongest === "UNAVAILABLE"
    tooltipText: "TravelCanary — " + root.pillText
    fixedWidth: root.vertical ? root.barSize : content.implicitWidth + Style.space(16)
    fixedHeight: root.vertical ? root.barSize : -1

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.space(6)

      Image {
        width: Style.space(17)
        height: width
        anchors.verticalCenter: parent.verticalCenter
        source: Qt.resolvedUrl("../public/brand/logo-icon.png")
        fillMode: Image.PreserveAspectFit
        smooth: true
        opacity: root.canaryService && root.canaryService.available ? 1 : 0.5
      }

      Text {
        visible: !root.vertical
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: root.pillText
        color: button.active ? button.activeColor : button.foreground
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.bodySmall
        font.bold: root.strongest === "SEVERE" || root.strongest === "HIGH"
      }
    }

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }
}
