import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "hypertrial.travelcanary"
  ipcTarget: "hypertrial.travelcanary"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var canaryService: null
  property int selectedIndex: 0
  readonly property var barIdentity: hostWidget || root
  readonly property var summary: canaryService ? canaryService.summary : null
  readonly property var destinations: summary && summary.destinations ? summary.destinations : []
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function openFromHotkey() { root.controller.show() }
  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? root.close() : root.openFromHotkey() }
  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function") return bar.switchPanelFrom(barIdentity, direction)
    return false
  }
  function refresh() {
    if (canaryService && typeof canaryService.refresh === "function") canaryService.refresh()
  }
  function moveSelection(delta) {
    if (!destinations.length) { selectedIndex = 0; return }
    selectedIndex = Math.max(0, Math.min(destinations.length - 1, selectedIndex + delta))
  }
  function openDestination(destination) {
    if (!destination || !canaryService) return
    var url = Model.destinationUrl(canaryService.serviceUrl, destination.id)
    if (url) Qt.openUrlExternally(url)
  }
  function activateSelection() {
    if (destinations.length) openDestination(destinations[selectedIndex])
    else refresh()
  }
  function openApplication() {
    if (!canaryService) return
    var url = Model.normalizeServiceUrl(canaryService.serviceUrl)
    if (url) Qt.openUrlExternally(url)
  }

  onDestinationsChanged: selectedIndex = Math.max(0, Math.min(selectedIndex, destinations.length - 1))

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveSelection(dy) }
      onActivateRequested: root.activateSelection()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(value) { if (value === "r" || value === "R") root.refresh() }

      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: panelColumn.implicitHeight
        boundsBehavior: Flickable.StopAtBounds
        clip: true

        Column {
          id: panelColumn
          width: parent.width
          spacing: Style.space(14)

          Row {
            width: parent.width
            spacing: Style.space(12)

            Image {
              width: Style.space(42)
              height: width
              anchors.verticalCenter: parent.verticalCenter
              source: Qt.resolvedUrl("../public/brand/logo-icon.png")
              fillMode: Image.PreserveAspectFit
              smooth: true
            }

            Column {
              width: parent.width - Style.space(112)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                text: "TRAVELCANARY"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
                font.bold: true
              }
              Text {
                textFormat: Text.PlainText
                text: root.canaryService && root.canaryService.available
                  ? Model.stateLabel(Model.strongestState(root.summary)) + " · " + root.summary.health + " · " + root.summary.freshness
                  : "Service unavailable"
                color: root.canaryService && root.canaryService.available ? root.foreground : root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
              Text {
                textFormat: Text.PlainText
                text: "Data update: " + Model.updatedLabel(root.summary)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            Button {
              text: root.canaryService && root.canaryService.refreshing ? "Refreshing…" : "Refresh"
              foreground: root.foreground
              enabled: root.canaryService && !root.canaryService.refreshing
              onClicked: root.refresh()
            }
          }

          Grid {
            visible: root.summary !== null
            width: parent.width
            columns: 3
            columnSpacing: Style.space(8)
            rowSpacing: Style.space(8)

            Repeater {
              model: root.summary ? [
                { label: "Severe", value: root.summary.counts.SEVERE },
                { label: "High", value: root.summary.counts.HIGH },
                { label: "Elevated", value: root.summary.counts.ELEVATED },
                { label: "Pending", value: root.summary.counts.UNKNOWN },
                { label: "Normal", value: root.summary.counts.NORMAL },
                { label: "Attention", value: root.summary.counts.attention }
              ] : []

              Rectangle {
                required property var modelData
                width: (panelColumn.width - Style.space(16)) / 3
                height: Style.space(54)
                radius: Style.cornerRadius
                color: Style.normalFillFor(root.foreground, Color.accent)

                Column {
                  anchors.centerIn: parent
                  spacing: Style.space(2)
                  Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    textFormat: Text.PlainText
                    text: String(modelData.value)
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                  }
                  Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    textFormat: Text.PlainText
                    text: modelData.label
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }
          }

          Rectangle {
            visible: root.summary && root.summary.restrictedSources.active
            width: parent.width
            height: restrictedText.implicitHeight + Style.space(20)
            radius: Style.cornerRadius
            color: Style.selectedFillFor(root.foreground, Color.accent)

            Text {
              id: restrictedText
              anchors.fill: parent
              anchors.margins: Style.space(10)
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              text: root.summary && root.summary.restrictedSources.disclosure
                ? root.summary.restrictedSources.disclosure
                : "Restricted data is present or collection is enabled under noncommercial source terms."
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }

          Column {
            visible: root.canaryService && root.canaryService.available && root.destinations.length > 0
            width: parent.width
            spacing: Style.space(4)

            Text {
              textFormat: Text.PlainText
              text: "URGENT OR UPDATE-DELAYED DESTINATIONS"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1
            }

            Repeater {
              model: root.destinations

              Rectangle {
                id: destinationRow
                required property var modelData
                required property int index
                width: parent.width
                height: Style.space(48)
                radius: Style.cornerRadius
                color: index === root.selectedIndex ? Style.selectedFillFor(root.foreground, Color.accent) : "transparent"

                Row {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(10)
                  anchors.rightMargin: Style.space(10)
                  spacing: Style.space(10)

                  Rectangle {
                    width: Style.space(8)
                    height: width
                    radius: width / 2
                    anchors.verticalCenter: parent.verticalCenter
                    color: modelData.level === "SEVERE" || modelData.level === "HIGH" ? root.urgent : root.dim
                  }
                  Column {
                    width: parent.width - Style.space(96)
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                      width: parent.width
                      textFormat: Text.PlainText
                      text: modelData.name
                      elide: Text.ElideRight
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      font.bold: index === root.selectedIndex
                    }
                    Text {
                      textFormat: Text.PlainText
                      text: modelData.countryCode + " · " + Model.stateLabel(modelData.level)
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "Open ›"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onPositionChanged: root.selectedIndex = index
                  onClicked: root.openDestination(modelData)
                }
              }
            }
          }

          Column {
            visible: !root.canaryService || !root.canaryService.available
            width: parent.width
            spacing: Style.space(8)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              text: "TravelCanary is not responding at the configured loopback URL. Start one of these local runtimes:"
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              width: parent.width
              textFormat: Text.PlainText
              wrapMode: Text.WrapAnywhere
              text: "Docker\nbin/travelcanary setup --runtime docker --port 3000\n\nNative Node/systemd\nbin/travelcanary setup --runtime native --port 3000"
              color: root.foreground
              font.family: "monospace"
              font.pixelSize: Style.font.bodySmall
              selectByMouse: true
            }
          }

          Button {
            visible: root.canaryService && root.canaryService.available
            text: "Open TravelCanary"
            foreground: root.foreground
            onClicked: root.openApplication()
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            text: "Middle-click the bar widget or press R here to refresh. Up/Down and Enter open a destination."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
