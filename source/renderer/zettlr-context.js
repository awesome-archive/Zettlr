/* global $ */
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZettlrCon class
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model builds and displays a context menu based on where
 *                  the oncontextmenu event occurred.
 *
 * END HEADER
 */

const { remote } = require('electron')
const { Menu } = remote
const ipc = require('electron').ipcRenderer
const { trans } = require('../common/lang/i18n.js')

/**
 * This class is a wrapper for the remote Menu class. What it does is basically
 * being called by ZettlrBody object, and then determine from the event itself,
 * how the context menu should be built. For instance, it will build a different
 * context menu, if it detects the parent #editor-element, or the #directories.
 * What I just realized is, that the context menu is **reference hell**, so in
 * a future version, the context menu should be moved to ... like the renderer.
 * Or, even better: the main process (because then it does not lock the renderer
 * on generation, making the experience smoother.)
 * @param {ZettlrBody} parent Body element.
 */
class ZettlrCon {
  constructor (parent) {
    this._body = parent
    this._menu = new Menu()
    // Where did the context menu handler appear?
    this._pos = { 'x': 0, 'y': 0 }
  }

  /**
   * Builds a context menu based on a given menutpl and some scoping vars.
   * @param  {Array} menutpl       The array containing the blueprints.
   * @param  {integer} [hash=null]   The hash, or null if not necessary.
   * @param  {integer} [vdhash=null] The vdhash, or null if not given.
   * @param  {Array}  [scopes=[]]   An array of scope-names ("root", "directory", etc.)
   * @param  {Array}  [attributes=[]]   An array of all attributes of the emanating element
   * @return {Array}               An array containing the generated items.
   */
  _buildFromSource (menutpl, hash = null, vdhash = null, scopes = [], attributes = []) {
    if (!menutpl) {
      throw new Error('No menutpl detected!')
    }

    let menu = []

    // Traverse the submenu and apply
    for (let item of menutpl) {
      // If an item is scoped and the scope does not apply here, don't include it.
      if (item.hasOwnProperty('scope') && !scopes.includes(item.scope)) continue
      // If an item is scoped by attribute and the attribute is not included, continue.
      if (item.hasOwnProperty('attribute') && !attributes.find(elem => elem.name === item.attribute)) continue
      let builtItem = {}
      // Simple copying of trivial attributes
      if (item.hasOwnProperty('label')) builtItem.label = trans(item.label)
      if (item.hasOwnProperty('type')) builtItem.type = item.type
      if (item.hasOwnProperty('role')) builtItem.role = item.role

      // Higher-order attributes

      // Accelerators may be system specific for macOS
      if (item.hasOwnProperty('accelerator')) builtItem.accelerator = item.accelerator

      // Commands need to be simply sent to the renderer
      let that = this
      if (item.hasOwnProperty('command')) {
        builtItem.click = function (menuitem, focusedWindow) {
          let content = (item.hasOwnProperty('content')) ? item.content : { 'hash': hash }
          if (vdhash) content.virtualdir = vdhash
          // Set the content to the attribute's value, if given
          if (item.hasOwnProperty('attribute')) content = attributes.find(elem => elem.name === item.attribute).value
          that._body.getRenderer().handleEvent(item.command, content)
        }
      }
      // Finally append the menu item
      menu.push(builtItem)
    }

    // As a last check, let's see if debug mode is on. If so, add the "Inspect
    // element" menu item.
    if (global.config.get('debug')) {
      menu.push({ 'type': 'separator' })
      menu.push({
        label: 'Inspect Element',
        click: () => {
          require('electron').remote.getCurrentWindow().inspectElement(this._pos.x, this._pos.y)
        }
      })
    }

    return menu
  }

  /**
    * Build the context menu.
    * @param  {Event} event The JavaScript event containing information for the menu
    * @return {void}       Nothing to return.
    */
  _build (event) {
    let elem = $(event.target)
    // No context menu for sorters
    if (elem.hasClass('sorter') || elem.parents('sorter').length > 0) return
    let hash = null
    let vdfile = false // Is this file part of a virtual directory?
    let vdhash = null
    let typoPrefix = []

    // If the user has right-clicked a link, select the link contents to make it
    // look better and give visual feedback that the user is indeed about to copy
    // the whole link into the clipboard, not a part of it.
    if (elem.hasClass('cma')) {
      let selection = window.getSelection()
      let range = document.createRange()
      range.selectNodeContents(elem[0])
      selection.removeAllRanges()
      selection.addRange(range)
    }

    // Used to hold the scopes
    let scopes = []
    // Used to hold the attributes
    let attr = []
    // Path to the template file to use.
    let menupath = ''

    // First: determine where the click happened (preview pane, directories or editor)
    if (elem.parents('#preview').length > 0) {
      // In case of preview, our wanted elements are: the p.filename-tag (containing
      // the name) inside the <li> and the data-hash attr inside the <li>
      if (elem.hasClass('filename') || elem.hasClass('file-meta') || elem.hasClass('taglist')) {
        elem = elem.parent() // Move up 1 level
      } else if (elem.is('span') || elem.hasClass('tagspacer')) {
        elem = elem.parent().parent() // Move up 2 levels
      } else if (elem.hasClass('tag')) {
        elem = elem.parent().parent().parent() // Move up 3 levels
      }

      if (elem.hasClass('directory')) return

      hash = elem.attr('data-hash')
      vdfile = elem.hasClass('vd-file')
      if (vdfile) vdhash = elem.attr('data-vd-hash')
      // Now determine the scope
      if (vdfile) scopes.push('virtual-directory')
      // Push all attributes into the attributes array
      for (let i = 0, nodes = elem[0].attributes; i < elem[0].attributes.length; i++) {
        // The attributes are a NamedNodeMap, so we have to use weird function calling to retrieve them
        attr.push({ 'name': nodes.item(i).nodeName, 'value': nodes.item(i).nodeValue })
      }
      menupath = 'preview_file.json'
    } else if (elem.parents('#directories').length > 0) {
      // In case of directories, our wanted elements are: Only the <li>s
      if (elem.is('li') || elem.is('span')) {
        if (elem.is('span')) {
          elem = elem.parent()
        }

        hash = elem.attr('data-hash')

        // Determine the scopes
        if (elem.hasClass('project')) {
          scopes.push('project')
        } else if (elem.hasClass('directory')) {
          scopes.push('no-project')
        }

        if (elem.hasClass('directory')) scopes.push('directory')

        if (elem.hasClass('root')) scopes.push('root')
        menupath = 'directories_directory.json'
      } else if (elem.is('div') && elem.hasClass('file')) {
        // Standalone root file selected
        hash = elem.attr('data-hash')
        menupath = 'directories_file.json'
      }
    } else if (elem.parents('#editor').length > 0) {
      // If the word is spelled wrong, request suggestions
      if (elem.hasClass('cm-spell-error')) {
        let suggestions = global.typo.suggest(elem.text())
        if (suggestions.length > 0) {
          for (let sug of suggestions) {
            typoPrefix.push({
              'label': sug,
              'click': (item, win) => {
                // TODO this is ugly!
                this._body.getRenderer().getEditor().replaceWord(sug)
              }
            })
          }
        } else {
          typoPrefix.push({
            'label': trans('menu.no_suggestions'),
            enabled: 'false'
          })
        }

        typoPrefix.push({ type: 'separator' })
        // Always add an option to add a word to the user dictionary
        typoPrefix.push({
          'label': trans('menu.add_to_dictionary'),
          'click': (item, win) => {
            // elem.text() contains the misspelled word
            ipc.sendSync('typo', {
              'type': 'add',
              'term': elem.text()
            })
            // IPC send: add to dict TODO
          }
        })
        // Final separator
        typoPrefix.push({ type: 'separator' })
      }
      menupath = 'editor.json'
    } else if (elem.is('input[type="text"]') || elem.is('textarea')) {
      menupath = 'text.json'
    }

    // Now build with all information we have gathered.
    this._menu = new Menu()
    this._menu = this._buildFromSource(require('./assets/context/' + menupath), hash, vdhash, scopes, attr)
    if (elem.hasClass('cm-spell-error')) this._menu = typoPrefix.concat(this._menu)

    // If the element is a link, add an "open link" context menu entry
    if (elem.hasClass('cma')) {
      let url = elem.attr('title')
      this._menu.unshift({
        'label': trans('menu.open_link'),
        'click': (item, win) => {
          require('electron').shell.openExternal(url)
        }
      }, {
        // It's either "Copy Link" or "Copy Mail"
        'label': (url.indexOf('mailto:') === 0) ? trans('menu.copy_mail') : trans('menu.copy_link'),
        'click': (item, win) => {
          let toCopy = (url.indexOf('mailto:') === 0) ? url.substr(7) : url
          require('electron').clipboard.writeText(toCopy)
        }
      }, {
        'type': 'separator'
      })
    }
    this._menu = Menu.buildFromTemplate(this._menu)
  }

  /**
    * Display the popup using the event passed by ZettlrBody
    * @param  {Event} event The oncontextmenu event
    * @return {void}       Nothing to return.
    */
  popup (event) {
    try {
      this._pos = { 'x': event.clientX, 'y': event.clientY }
      this._build(event)
      if (this._menu.items.length > 0) {
        // Open at click coords even the user may have moved the mouse
        this._menu.popup(this._pos)
      }
    } catch (e) { /* Fail silently */ }
  }
}

module.exports = ZettlrCon
