/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZettlrWindow class
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This class is responsible for the main window of Zettlr. It
 *                  opens it, closes it, controls the title and diverse other
 *                  stuff that has to do with the window itself (such as showing
 *                  modal boxes, e.g. errors or dialogs for opening new paths.)
 *
 * END HEADER
 */

const electron = require('electron')
const { dialog, BrowserWindow, app } = electron
const url = require('url')
const path = require('path')
const { trans } = require('../common/lang/i18n.js')
const { isDir } = require('../common/zettlr-helpers.js')
const ZettlrMenu = require('./zettlr-menu.js')

/**
 * This class is a wrapper for electron's BrowserWindow class with some functions
 * that make the handling of it much more easy. But besides of that, it's not
 * much.
 */
class ZettlrWindow {
  /**
    * Initiate a new window.
    * @param {Zettlr} parent The main zettlr object.
    */
  constructor (parent) {
    this._app = parent
    this._win = null
    this._menu = null
  }

  /**
    * Create and open a new main window
    * @return {ZettlrWindow} Again this for chainability.
    */
  open () {
    // There is still a window active, so don't do anything (one-window app)
    if (this._win != null) return this

    // Prepare saved attributes from the config.
    let winWidth = global.config.get('window.width')
    let winHeight = global.config.get('window.height')
    let winX = global.config.get('window.x')
    let winY = global.config.get('window.y')
    let winMax = global.config.get('window.max')

    // Sanity checks
    let screensize = electron.screen.getPrimaryDisplay().workAreaSize
    if (typeof winWidth !== 'number' || winWidth > screensize.width) winWidth = screensize.width
    if (typeof winHeight !== 'number' || winHeight > screensize.height) winHeight = screensize.height
    if (typeof winX !== 'number' || winX > screensize.width) winX = 0
    if (typeof winY !== 'number' || winY > screensize.height) winY = 0
    if (typeof winMax !== 'boolean') winMax = true

    let winConf = {
      width: winWidth,
      height: winHeight,
      x: winX,
      y: winY,
      acceptFirstMouse: true,
      minWidth: 176,
      minHeight: 144,
      show: false,
      icon: 'icons/png/64x64.png',
      webPreferences: {
        // Zettlr needs all the node features, so in preparation for Electron
        // 5.0 we'll need to explicitly request it.
        nodeIntegration: true
      },
      backgroundColor: '#fff',
      scrollBounce: true, // The nice scrolling effect for macOS
      defaultEncoding: 'utf8' // Why the hell does this default to ISO?
    }

    // On macOS create a chromeless window with the window controls.
    if (process.platform === 'darwin') {
      winConf.titleBarStyle = 'hiddenInset'
    }

    // Remove the frame on Linux and Windows
    if (process.platform === 'linux' || process.platform === 'win32') {
      winConf.frame = false
    }

    // First create a new browserWindow
    this._win = new BrowserWindow(winConf)

    // Then activate listeners.
    // and load the index.html of the app.
    this._win.loadURL(url.format({
      pathname: path.join(__dirname, '../renderer/assets/index.htm'),
      protocol: 'file:',
      slashes: true
    }))

    // EVENT LISTENERS

    // Only show window once it is completely initialized + maximize it
    this._win.once('ready-to-show', () => {
      this._win.show()
      if (global.config.get('window.max')) this._win.maximize()
    })

    // Emitted when the window is closed.
    this._win.on('closed', () => {
      global.mainWindow = null // Unset the global
      this.close()
    })

    // Emitted when the user wants to close the window.
    this._win.on('close', (event) => {
      // Only check, if we can close. Unless we can, abort closing process.
      if (this._app.isModified()) {
        // The current document is modified, so send a win-close event to the
        // renderer, triggering a save command prior to actually closing the
        // window.
        event.preventDefault()
        global.ipc.send('win-close')
      } else {
        // We can close - so clear down the cache in any case
        let ses = this._win.webContents.session
        // Do not "clearCache" because that would only delete my own index files
        ses.clearStorageData({
          storages: [
            'appcache',
            'cookies', // Nobody needs cookies except for downloading pandoc etc
            'localstorage',
            'shadercache', // Should never contain anything
            'websql'
          ]
        })
      }
    })

    // Now resizing events to save the last positions to config
    let sizingCallback = (event) => {
      let newBounds = this._win.getBounds()
      global.config.set('window.x', newBounds.x)
      global.config.set('window.y', newBounds.y)
      global.config.set('window.width', newBounds.width)
      global.config.set('window.height', newBounds.height)
      // On macOS there's no "unmaximize", therefore we have to check manually.
      let s = electron.screen.getPrimaryDisplay().workArea
      if (newBounds.width < s.width || newBounds.height < s.height || newBounds.x > s.x || newBounds.y > s.y) {
        global.config.set('window.max', false)
      } else {
        global.config.set('window.max', true)
      }
    }
    this._win.on('maximize', (event) => {
      global.config.set('window.max', true)
    })
    this._win.on('unmaximize', (event) => {
      global.config.set('window.max', false)
    })
    this._win.on('resize', sizingCallback)
    this._win.on('move', sizingCallback)

    // Prevent closing if unable to comply
    this._win.beforeunload = (e) => {
      if (!this.canClose()) {
        // Prevent closing for now.
        e.returnValue = false
        // And ask the user to save changes. The parent will then re-
        // emit the close-event which in the second round will not
        // trigger this if-loop.
        this._app.saveAndClose()
      }
    }

    // Set the application menu
    this._menu = new ZettlrMenu(this)
    this._menu.set()

    // Push the window into the globals that the menu for instance can access it
    // to send commands.
    global.mainWindow = this._win

    // Enable classes from within the app to update the menu
    global.refreshMenu = () => { this._menu.set() }

    return this
  }
  // END this.open

  /**
    * Sets the title and always appends Zettlr to it.
    * @param {String} [newTitle=''] The new title to set.
    * @return {ZettlrWindow} This for chainability.
    * @deprecated Will be removed in a further version in exchange for fileUpdate()
    */
  setTitle (newTitle = '') {
    if (newTitle === '') {
      newTitle = 'Zettlr'
    }

    this._win.setTitle(newTitle)
  }

  /**
    * This function should be triggered if the currently opened file changes to
    * reflect the file in the window title.
    * @return {ZettlrWindow} This for chainability.
    */
  fileUpdate () {
    let curFile = this._app.getCurrentFile()
    if (curFile == null) {
      this.setTitle()
    } else {
      this.setTitle(curFile.name)
    }
  }

  /**
    * Returns the current window title
    * @return {String} The window's current title.
    */
  getTitle () {
    return this._win.getTitle()
  }

  /**
   * Toggle the maximisation of the window (either maximise or unmaximise)
   * @return {ZettlrWindow} Chainability.
   */
  toggleMaximise () {
    if (this._win.isMaximized()) {
      this._win.unmaximize()
    } else {
      this._win.maximize()
    }

    return this
  }

  /**
   * Shows a popup application menu at the specified coordinates
   * @param  {number} x The x-position of the menu
   * @param  {number} y The y-position of the menu
   * @return {void}   Does not return
   */
  popupMenu (x, y) {
    this._menu.popup(x, y)
  }

  /**
    * Indicates that there are unsaved changes with a star in title and, on
    * macOS, also the indicator in the traffic lights.
    * @return {ZettlrWindow} This for chainability.
    */
  setModified () {
    // Set the modified flag on the window if the file is edited (macOS only)
    // Function does nothing if not on macOS
    if (this._win != null) {
      this._win.setDocumentEdited(true)
    }

    return this
  }

  /**
    * Removes any marks that indicate modifications.
    * @return {ZettlrWindow} This for chainability.
    */
  clearModified () {
    // Clear the modified flag on the window if the file is edited (macOS only)
    if (this._win != null) {
      this._win.setDocumentEdited(false)
    }

    return this
  }

  /**
    * Returns the current window instance (or null, if window is null)
    * @return {Mixed} Either a BrowserWindow instance or null
    */
  getWindow () {
    return this._win
  }

  // FUNCTIONS CALLED FROM WITHIN EVENT LISTENERS

  /**
    * Dereference a window if it has been destroyed (called by BrowserWindow)
    * @return {void} Does not return anything.
    */
  close () {
    // Dereference the window.
    this._win = null
  }

  /**
    * Can we close the window?
    * @return {Boolean} Returns either true or false depending on modification flag on parent.
    */
  canClose () {
    return this._app.canClose()
  }

  /**
    * Prompt the user to save or omit changes, or cancel the process completely.
    * @return {Integer} Either 0 (cancel), 1 (save changes) or 2 (omit changes)
    */
  askSaveChanges () {
    let options = {
      type: 'question',
      title: trans('system.save_changes_title'),
      message: trans('system.save_changes_message'),
      buttons: [
        trans('system.save_changes_cancel'),
        trans('system.save_changes_save'),
        trans('system.save_changes_omit')
      ],
      cancelId: 0,
      defaultId: 1
    }

    let ret = dialog.showMessageBox(this._win, options)

    // ret can have three status: cancel = 0, save = 1, omit = 2.
    // To keep up with semantics, the function "askSaveChanges" would
    // naturally return "true" if the user wants to save changes and "false"
    // - so how deal with "omit" changes?
    // Well I don't want to create some constants so let's just leave it
    // with these three values.
    return ret
  }

  /**
    * The currently opened file's contents have changed on disk -- reload?
    * @return {Integer} 0 (Do not replace the file) or 1 (Replace the file)
    */
  askReplaceFile (callback) {
    let options = {
      type: 'question',
      title: trans('system.replace_file_title'),
      message: trans('system.replace_file_message'),
      checkboxLabel: trans('dialog.preferences.always_reload_files'),
      checkboxChecked: global.config.get('alwaysReloadFiles'),
      buttons: [
        trans('system.cancel'),
        trans('system.ok')
      ],
      cancelId: 0,
      defaultId: 1
    }

    // Asynchronous message box to not block the main process
    dialog.showMessageBox(this._win, options, callback)
  }

  /**
    * Show the dialog for choosing a directory
    * @return {Array}          An array containing all selected paths.
    */
  askDir () {
    let startDir = app.getPath('home')
    if (isDir(global.config.get('dialogPaths.askDirDialog'))) {
      startDir = global.config.get('dialogPaths.askDirDialog')
    }

    let ret = dialog.showOpenDialog(this._win, {
      title: trans('system.open_folder'),
      defaultPath: startDir,
      properties: [
        'openDirectory',
        'createDirectory' // macOS only
      ]
    }) || [] // In case the dialog spits out an undefined we need a default array

    // Save the path of the dir into the config
    if (ret.length > 0 && isDir(path.dirname(ret[0]))) {
      global.config.set('dialogPaths.askDirDialog', ret[0])
    }

    return ret
  }

  /**
   * Shows the dialog for importing files from the disk.
   * @param  {Array}  [filters=null]   An array of extension filters.
   * @param  {Boolean} [multiSel=false] Determines if multiple files are allowed
   * @param {String} [startDir]       The starting directory
   * @return {Array}                   An array containing all selected files.
   */
  askFile (filters = null, multiSel = false, startDir = global.config.get('dialogPaths.askFileDialog')) {
    // Sanity check for default start directory.
    if (!isDir(startDir)) startDir = app.getPath('documents')

    // Fallback filter: All files
    if (!filters) filters = [{ 'name': trans('system.all_files'), 'extensions': ['*'] }]

    // Prepare options
    let opt = {
      'title': trans('system.open_file'),
      'defaultPath': startDir,
      'properties': [
        'openFile'
      ],
      'filters': filters
    }

    // Should multiple selections be allowed?
    if (multiSel) opt.properties.push('multiSelections')

    let ret = dialog.showOpenDialog(this._win, opt) || [] // In case the dialog spits out an undefined we need a default array

    // Save the path of the containing dir of the first file into the config
    if (ret.length > 0 && isDir(path.dirname(ret[0]))) {
      global.config.set('dialogPaths.askFileDialog', ret[0])
    }

    return ret
  }

  /**
    * This function prompts the user with information.
    * @param  {Object} options Necessary informations for displaying the prompt
    * @return {ZettlrWindow}         This for chainability.
    */
  prompt (options) {
    if (typeof options === 'string') {
      options = { 'message': options }
    }

    dialog.showMessageBox(this._win, {
      type: options.type || 'info',
      buttons: [ 'Ok' ],
      defaultId: 0,
      title: options.title || 'Zettlr',
      message: options.message
    })

    return this
  }

  /**
    * Ask to remove the given object (either ZettlrFile or ZettlrDirectory)
    * @param  {Mixed} obj Either ZettlrFile or ZettlrDirectory
    * @return {Boolean}     True if user wishes to remove it, or false.
    */
  confirmRemove (obj) {
    let ret = dialog.showMessageBox(this._win, {
      type: 'warning',
      buttons: [ 'Ok', trans('system.error.cancel_remove') ],
      defaultId: 0,
      cancelId: 1,
      title: trans('system.error.remove_title'),
      message: trans('system.error.remove_message', obj.name)
    })

    // 0 = Ok, 1 = Cancel

    return (ret === 0)
  }

  /**
    * Returns the Zettlr main object
    * @return {Zettlr} The parent app object
    */
  getApp () { return this._app }
}

module.exports = ZettlrWindow
