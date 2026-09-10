import QtQuick
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root
  visible: false

  property string serviceUrl: "http://127.0.0.1:3000"
  property int refreshIntervalSec: 300
  property var summary: null
  property bool available: false
  property bool refreshing: false
  property string lastError: ""
  property string lastCheckedAt: ""
  property string _stdout: ""
  property string _stderr: ""

  function configure(candidateUrl, candidateInterval) {
    var normalized = Model.normalizeServiceUrl(candidateUrl)
    var interval = Model.clampRefreshInterval(candidateInterval)
    var changed = normalized !== serviceUrl || interval !== refreshIntervalSec
    serviceUrl = normalized
    refreshIntervalSec = interval
    if (!serviceUrl) {
      available = false
      lastError = "Service URL must be a loopback HTTP origin"
      poll.running = false
      return
    }
    poll.running = true
    if (changed) refresh()
  }

  function refresh() {
    if (request.running) return
    if (!serviceUrl) {
      available = false
      lastError = "Service URL must be a loopback HTTP origin"
      return
    }
    _stdout = ""
    _stderr = ""
    refreshing = true
    var resolveArguments = []
    if (serviceUrl.indexOf("http://localhost") === 0) {
      var match = serviceUrl.match(/^http:\/\/localhost(?::(\d+))?$/)
      resolveArguments = ["--resolve", "localhost:" + (match && match[1] ? match[1] : "80") + ":127.0.0.1"]
    }
    request.command = [
      "curl", "--fail", "--silent", "--show-error",
      "--connect-timeout", "2", "--max-time", "5",
      "--max-filesize", "65536", "--max-redirs", "0",
      "--noproxy", "*", "--proto", "=http"
    ].concat(resolveArguments).concat([serviceUrl + "/api/v1/plugin/summary"])
    request.running = true
  }

  Timer {
    id: poll
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: request
    running: false
    command: []
    stdout: StdioCollector { id: responseOutput; waitForEnd: true; onStreamFinished: root._stdout = text }
    stderr: StdioCollector { id: responseError; waitForEnd: true; onStreamFinished: root._stderr = text }
    onExited: function(exitCode) {
      root.refreshing = false
      root.lastCheckedAt = new Date().toISOString()
      var parsed = exitCode === 0 ? Model.parseSummary(String(responseOutput.text || root._stdout || "")) : null
      if (parsed) {
        root.summary = parsed
        root.available = true
        root.lastError = ""
      } else {
        root.available = false
        var detail = String(responseError.text || root._stderr || "").replace(/\s+/g, " ").trim()
        root.lastError = detail ? detail.substring(0, 160) : "TravelCanary service unavailable"
      }
    }
  }
}
