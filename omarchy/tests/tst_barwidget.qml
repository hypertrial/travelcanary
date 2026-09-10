import QtQuick
import QtTest
import ".." as TravelCanary

TestCase {
  id: testCase
  name: "TravelCanaryBarWidget"
  when: windowShown

  property QtObject fakeService: QtObject {
    property bool available: true
    property bool refreshing: false
    property string serviceUrl: "http://127.0.0.1:3000"
    property int refreshes: 0
    property var summary: ({
      schemaVersion: 1,
      appVersion: "0.1.0",
      catalogVersion: 3,
      health: "ok",
      freshness: "fresh",
      generatedAt: "2026-09-10T12:00:00.000Z",
      restrictedSources: { active: false, count: 6, disclosure: "" },
      counts: { NORMAL: 678, ELEVATED: 0, HIGH: 1, SEVERE: 0, UNKNOWN: 0, attention: 1 },
      destinations: [{ id: "fr-paris", name: "Paris", countryCode: "FR", level: "HIGH", updatePending: false }]
    })
    function configure(url, interval) { serviceUrl = url }
    function refresh() { refreshes += 1 }
  }

  property QtObject fakeShell: QtObject {
    function serviceFor(id) { return id === "hypertrial.travelcanary" ? testCase.fakeService : null }
  }

  property QtObject fakeBar: QtObject {
    property var shell: testCase.fakeShell
    property color foreground: "white"
    property color barForeground: "white"
    property color background: "black"
    property color urgent: "red"
    property string fontFamily: "sans-serif"
    property string position: "top"
    property bool vertical: false
    property int barSize: 32
    property bool foregroundAnimationEnabled: false
    function showTooltip(target, text) {}
    function hideTooltip(target) {}
    function registerClickTarget(target) {}
    function unregisterClickTarget(target) {}
    function switchPanelFrom(owner, direction) { return false }
  }

  Component {
    id: widgetComponent
    TravelCanary.BarWidget {
      bar: testCase.fakeBar
      settings: ({ serviceUrl: "http://127.0.0.1:3000", refreshIntervalSec: 300 })
    }
  }

  function test_fakeServiceSummaryAndRefresh() {
    var widget = createTemporaryObject(widgetComponent, testCase)
    verify(widget !== null)
    compare(widget.strongest, "HIGH")
    compare(widget.attention, 1)
    widget.refresh()
    compare(fakeService.refreshes, 1)
  }
}
