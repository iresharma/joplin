import { useEffect, useState, useRef, useCallback } from 'react';
import { AppState } from '../app';
import InteropService from '@joplin/lib/services/interop/InteropService';
import { stateUtils } from '@joplin/lib/reducer';
import CommandService from '@joplin/lib/services/CommandService';
import MenuUtils from '@joplin/lib/services/commands/MenuUtils';
import KeymapService from '@joplin/lib/services/KeymapService';
import { PluginStates, utils as pluginUtils } from '@joplin/lib/services/plugins/reducer';
import shim from '@joplin/lib/shim';
import Setting from '@joplin/lib/models/Setting';
import versionInfo from '@joplin/lib/versionInfo';
import { Module } from '@joplin/lib/services/interop/types';
import InteropServiceHelper from '../InteropServiceHelper';
import { _ } from '@joplin/lib/locale';
import { isContextMenuItemLocation, MenuItem, MenuItemLocation } from '@joplin/lib/services/plugins/api/types';
import SpellCheckerService from '@joplin/lib/services/spellChecker/SpellCheckerService';
import menuCommandNames from './menuCommandNames';
import stateToWhenClauseContext from '../services/commands/stateToWhenClauseContext';
import bridge from '../services/bridge';
import checkForUpdates from '../checkForUpdates';

const { connect } = require('react-redux');
import { reg } from '@joplin/lib/registry';
const packageInfo = require('../packageInfo.js');
const { clipboard } = require('electron');
const Menu = bridge().Menu;
const PluginManager = require('@joplin/lib/services/PluginManager');
const TemplateUtils = require('@joplin/lib/TemplateUtils');

const menuUtils = new MenuUtils(CommandService.instance());

function pluginMenuItemsCommandNames(menuItems: MenuItem[]): string[] {
	let output: string[] = [];
	for (const menuItem of menuItems) {
		if (menuItem.submenu) {
			output = output.concat(pluginMenuItemsCommandNames(menuItem.submenu));
		} else {
			if (menuItem.commandName) output.push(menuItem.commandName);
		}
	}
	return output;
}

function pluginCommandNames(plugins: PluginStates): string[] {
	let output: string[] = [];

	for (const view of pluginUtils.viewsByType(plugins, 'menu')) {
		output = output.concat(pluginMenuItemsCommandNames(view.menuItems));
	}

	for (const view of pluginUtils.viewsByType(plugins, 'menuItem')) {
		if (view.commandName) output.push(view.commandName);
	}

	return output;
}

function createPluginMenuTree(label: string, menuItems: MenuItem[], onMenuItemClick: Function) {
	const output: any = {
		label: label,
		submenu: [],
	};

	for (const menuItem of menuItems) {
		if (menuItem.submenu) {
			output.submenu.push(createPluginMenuTree(menuItem.label, menuItem.submenu, onMenuItemClick));
		} else {
			output.submenu.push(menuUtils.commandToMenuItem(menuItem.commandName, onMenuItemClick));
		}
	}

	return output;
}

interface Props {
	dispatch: Function;
	menuItemProps: any;
	routeName: string;
	selectedFolderId: string;
	layoutButtonSequence: number;
	['notes.sortOrder.field']: string;
	['folders.sortOrder.field']: string;
	['notes.sortOrder.reverse']: boolean;
	['folders.sortOrder.reverse']: boolean;
	showNoteCounts: boolean;
	uncompletedTodosOnTop: boolean;
	showCompletedTodos: boolean;
	pluginMenuItems: any[];
	pluginMenus: any[];
	['spellChecker.enabled']: boolean;
	['spellChecker.language']: string;
	plugins: PluginStates;
	customCss: string;
}

const commandNames: string[] = menuCommandNames();

function menuItemSetChecked(id: string, checked: boolean) {
	const menu = Menu.getApplicationMenu();
	const menuItem = menu.getMenuItemById(id);
	if (!menuItem) return;
	menuItem.checked = checked;
}

function menuItemSetEnabled(id: string, enabled: boolean) {
	const menu = Menu.getApplicationMenu();
	const menuItem = menu.getMenuItemById(id);
	if (!menuItem) return;
	menuItem.enabled = enabled;
}

function useMenuStates(menu: any, props: Props) {
	useEffect(() => {
		let timeoutId: any = null;

		function scheduleUpdate() {
			if (!timeoutId) return; // Was cancelled
			timeoutId = null;

			const whenClauseContext = CommandService.instance().currentWhenClauseContext();

			for (const commandName in props.menuItemProps) {
				const p = props.menuItemProps[commandName];
				if (!p) continue;
				const enabled = 'enabled' in p ? p.enabled : CommandService.instance().isEnabled(commandName, whenClauseContext);
				menuItemSetEnabled(commandName, enabled);
			}

			const layoutButtonSequenceOptions = Setting.enumOptions('layoutButtonSequence');
			for (const value in layoutButtonSequenceOptions) {
				menuItemSetChecked(`layoutButtonSequence_${value}`, props.layoutButtonSequence === Number(value));
			}

			function applySortItemCheckState(type: string) {
				const sortOptions = Setting.enumOptions(`${type}.sortOrder.field`);
				for (const field in sortOptions) {
					if (!sortOptions.hasOwnProperty(field)) continue;
					menuItemSetChecked(`sort:${type}:${field}`, (props as any)[`${type}.sortOrder.field`] === field);
				}

				menuItemSetChecked(`sort:${type}:reverse`, (props as any)[`${type}.sortOrder.reverse`]);
			}

			applySortItemCheckState('notes');
			applySortItemCheckState('folders');

			menuItemSetChecked('showNoteCounts', props.showNoteCounts);
			menuItemSetChecked('uncompletedTodosOnTop', props.uncompletedTodosOnTop);
			menuItemSetChecked('showCompletedTodos', props.showCompletedTodos);
		}

		timeoutId = setTimeout(scheduleUpdate, 150);

		return () => {
			clearTimeout(timeoutId);
			timeoutId = null;
		};
	}, [
		props.menuItemProps,
		props.layoutButtonSequence,
		props['notes.sortOrder.field'],
		props['folders.sortOrder.field'],
		props['notes.sortOrder.reverse'],
		props['folders.sortOrder.reverse'],
		props.showNoteCounts,
		props.uncompletedTodosOnTop,
		props.showCompletedTodos,
		menu,
	]);
}

function useMenu(props: Props) {
	const [menu, setMenu] = useState(null);
	const [keymapLastChangeTime, setKeymapLastChangeTime] = useState(Date.now());
	const [modulesLastChangeTime, setModulesLastChangeTime] = useState(Date.now());

	const onMenuItemClick = useCallback((commandName: string) => {
		void CommandService.instance().execute(commandName);
	}, []);

	const onImportModuleClick = useCallback(async (module: Module, moduleSource: string) => {
		let path = null;

		if (moduleSource === 'file') {
			path = bridge().showOpenDialog({
				filters: [{ name: module.description, extensions: module.fileExtensions }],
			});
		} else {
			path = bridge().showOpenDialog({
				properties: ['openDirectory', 'createDirectory'],
			});
		}

		if (!path || (Array.isArray(path) && !path.length)) return;

		if (Array.isArray(path)) path = path[0];

		const modalMessage = _('Importing from "%s" as "%s" format. Please wait...', path, module.format);

		void CommandService.instance().execute('showModalMessage', modalMessage);

		const errors: any[] = [];

		const importOptions = {
			path,
			format: module.format,
			outputFormat: module.outputFormat,
			onProgress: (status: any) => {
				const statusStrings: string[] = Object.keys(status).map((key: string) => {
					return `${key}: ${status[key]}`;
				});

				void CommandService.instance().execute('showModalMessage', `${modalMessage}\n\n${statusStrings.join('\n')}`);
			},
			onError: (error: any) => {
				errors.push(error);
				console.warn(error);
			},
			destinationFolderId: !module.isNoteArchive && moduleSource === 'file' ? props.selectedFolderId : null,
		};

		const service = InteropService.instance();
		try {
			const result = await service.import(importOptions);
			console.info('Import result: ', result);
		} catch (error) {
			bridge().showErrorMessageBox(error.message);
		}

		if (errors.length) {
			bridge().showErrorMessageBox('There was some errors importing the notes. Please check the console for more details.');
			props.dispatch({ type: 'NOTE_DEVTOOLS_SET', value: true });
		}

		void CommandService.instance().execute('hideModalMessage');
	}, [props.selectedFolderId]);

	const onMenuItemClickRef = useRef(null);
	onMenuItemClickRef.current = onMenuItemClick;

	const onImportModuleClickRef = useRef(null);
	onImportModuleClickRef.current = onImportModuleClick;

	useEffect(() => {
		let timeoutId: any = null;

		function updateMenu() {
			if (!timeoutId) return; // Has been cancelled

			const keymapService = KeymapService.instance();

			const pluginCommandNames = props.pluginMenuItems.map((view: any) => view.commandName);
			const menuItemDic = menuUtils.commandsToMenuItems(commandNames.concat(pluginCommandNames), (commandName: string) => onMenuItemClickRef.current(commandName));

			const quitMenuItem = {
				label: _('Quit'),
				accelerator: keymapService.getAccelerator('quit'),
				click: () => { void bridge().electronApp().quit(); },
			};

			const sortNoteFolderItems = (type: string) => {
				const sortItems = [];
				const sortOptions = Setting.enumOptions(`${type}.sortOrder.field`);
				for (const field in sortOptions) {
					if (!sortOptions.hasOwnProperty(field)) continue;
					sortItems.push({
						id: `sort:${type}:${field}`,
						label: sortOptions[field],
						type: 'checkbox',
						// checked: Setting.value(`${type}.sortOrder.field`) === field,
						click: () => {
							Setting.setValue(`${type}.sortOrder.field`, field);
						},
					});
				}

				sortItems.push({ type: 'separator' });

				sortItems.push({
					id: `sort:${type}:reverse`,
					label: Setting.settingMetadata(`${type}.sortOrder.reverse`).label(),
					type: 'checkbox',
					// checked: Setting.value(`${type}.sortOrder.reverse`),
					click: () => {
						Setting.setValue(`${type}.sortOrder.reverse`, !Setting.value(`${type}.sortOrder.reverse`));
					},
				});

				return sortItems;
			};

			const sortNoteItems = sortNoteFolderItems('notes');
			const sortFolderItems = sortNoteFolderItems('folders');

			const focusItems = [
				menuItemDic.focusElementSideBar,
				menuItemDic.focusElementNoteList,
				menuItemDic.focusElementNoteTitle,
				menuItemDic.focusElementNoteBody,
			];

			const importItems = [];
			const exportItems = [];
			const templateItems: any[] = [];
			const ioService = InteropService.instance();
			const ioModules = ioService.modules();
			for (let i = 0; i < ioModules.length; i++) {
				const module = ioModules[i];
				if (module.type === 'exporter') {
					if (module.isNoteArchive !== false) {
						exportItems.push({
							label: module.fullLabel(),
							click: async () => {
								await InteropServiceHelper.export(
									(action: any) => props.dispatch(action),
									module,
									{
										plugins: props.plugins,
										customCss: props.customCss,
									}
								);
							},
						});
					}
				} else {
					for (let j = 0; j < module.sources.length; j++) {
						const moduleSource = module.sources[j];
						importItems.push({
							label: module.fullLabel(moduleSource),
							click: () => onImportModuleClickRef.current(module, moduleSource),
						});
					}
				}
			}

			exportItems.push(
				menuItemDic.exportPdf
			);

			// We need a dummy entry, otherwise the ternary operator to show a
			// menu item only on a specific OS does not work.
			const noItem = {
				type: 'separator',
				visible: false,
			};

			const syncStatusItem = {
				label: _('Synchronisation Status'),
				click: () => {
					props.dispatch({
						type: 'NAV_GO',
						routeName: 'Status',
					});
				},
			};

			const separator = () => {
				return {
					type: 'separator',
				};
			};

			const newNoteItem = menuItemDic.newNote;
			const newTodoItem = menuItemDic.newTodo;
			const newFolderItem = menuItemDic.newFolder;
			const newSubFolderItem = menuItemDic.newSubFolder;
			const printItem = menuItemDic.print;

			templateItems.push({
				label: _('Create note from template'),
				click: () => {
					void CommandService.instance().execute('selectTemplate', 'note');
				},
			}, {
				label: _('Create to-do from template'),
				click: () => {
					void CommandService.instance().execute('selectTemplate', 'todo');
				},
			}, {
				label: _('Insert template'),
				accelerator: keymapService.getAccelerator('insertTemplate'),
				click: () => {
					void CommandService.instance().execute('selectTemplate');
				},
			}, {
				label: _('Open template directory'),
				click: () => {
					void bridge().openItem(Setting.value('templateDir'));
				},
			}, {
				label: _('Refresh templates'),
				click: async () => {
					const templates = await TemplateUtils.loadTemplates(Setting.value('templateDir'));

					props.dispatch({
						type: 'TEMPLATE_UPDATE_ALL',
						templates: templates,
					});
				},
			});

			let toolsItems: any[] = [];

			// we need this workaround, because on macOS the menu is different
			const toolsItemsWindowsLinux: any[] = [
				{
					label: _('Options'),
					accelerator: keymapService.getAccelerator('config'),
					click: () => {
						props.dispatch({
							type: 'NAV_GO',
							routeName: 'Config',
						});
					},
				},
				separator(),
			];

			// the following menu items will be available for all OS under Tools
			const toolsItemsAll = [{
				label: _('Note attachments...'),
				click: () => {
					props.dispatch({
						type: 'NAV_GO',
						routeName: 'Resources',
					});
				},
			}];

			if (!shim.isMac()) {
				toolsItems = toolsItems.concat(toolsItemsWindowsLinux);
			}
			toolsItems = toolsItems.concat(toolsItemsAll);

			toolsItems.push(SpellCheckerService.instance().spellCheckerConfigMenuItem(props['spellChecker.language'], props['spellChecker.enabled']));

			function _checkForUpdates() {
				void checkForUpdates(false, bridge().window(), { includePreReleases: Setting.value('autoUpdate.includePreReleases') });
			}

			function _showAbout() {
				const v = versionInfo(packageInfo);

				const copyToClipboard = bridge().showMessageBox(v.message, {
					icon: `${bridge().electronApp().buildDir()}/icons/128x128.png`,
					buttons: [_('Copy'), _('OK')],
					cancelId: 1,
					defaultId: 1,
				});

				if (copyToClipboard === 0) {
					clipboard.writeText(v.body);
				}
			}

			const rootMenuFile = {
				// Using a dummy entry for macOS here, because first menu
				// becomes 'Joplin' and we need a nenu called 'File' later.
				label: shim.isMac() ? '&JoplinMainMenu' : _('&File'),
				// `&` before one of the char in the label name mean, that
				// <Alt + F> will open this menu. It's needed becase electron
				// opens the first menu on Alt press if no hotkey assigned.
				// Issue: https://github.com/laurent22/joplin/issues/934
				submenu: [{
					label: _('About Joplin'),
					visible: shim.isMac() ? true : false,
					click: () => _showAbout(),
				}, {
					type: 'separator',
					visible: shim.isMac() ? true : false,
				}, {
					label: _('Preferences...'),
					visible: shim.isMac() ? true : false,
					accelerator: shim.isMac() && keymapService.getAccelerator('config'),
					click: () => {
						props.dispatch({
							type: 'NAV_GO',
							routeName: 'Config',
						});
					},
				}, {
					label: _('Check for updates...'),
					visible: shim.isMac() ? true : false,
					click: () => _checkForUpdates(),
				}, {
					type: 'separator',
					visible: shim.isMac() ? true : false,
				},
				shim.isMac() ? noItem : newNoteItem,
				shim.isMac() ? noItem : newTodoItem,
				shim.isMac() ? noItem : newFolderItem,
				shim.isMac() ? noItem : newSubFolderItem,
				{
					type: 'separator',
					visible: shim.isMac() ? false : true,
				}, {
					label: _('Templates'),
					visible: shim.isMac() ? false : true,
					submenu: templateItems,
				}, {
					type: 'separator',
					visible: shim.isMac() ? false : true,
				}, {
					label: _('Import'),
					visible: shim.isMac() ? false : true,
					submenu: importItems,
				}, {
					label: _('Export all'),
					visible: shim.isMac() ? false : true,
					submenu: exportItems,
				}, {
					type: 'separator',
				},

				menuItemDic.synchronize,

				shim.isMac() ? noItem : printItem, {
					type: 'separator',
					platforms: ['darwin'],
				},

				shim.isMac() ? {
					label: _('Hide %s', 'Joplin'),
					platforms: ['darwin'],
					accelerator: shim.isMac() && keymapService.getAccelerator('hideApp'),
					click: () => { bridge().electronApp().hide(); },
				} : noItem,

				{
					type: 'separator',
				},
				quitMenuItem],
			};

			const rootMenuFileMacOs = {
				label: _('&File'),
				visible: shim.isMac() ? true : false,
				submenu: [
					newNoteItem,
					newTodoItem,
					newFolderItem,
					newSubFolderItem,
					{
						label: _('Close Window'),
						platforms: ['darwin'],
						accelerator: shim.isMac() && keymapService.getAccelerator('closeWindow'),
						selector: 'performClose:',
					}, {
						type: 'separator',
					}, {
						label: _('Templates'),
						submenu: templateItems,
					}, {
						type: 'separator',
					}, {
						label: _('Import'),
						submenu: importItems,
					}, {
						label: _('Export all'),
						submenu: exportItems,
					}, {
						type: 'separator',
					},
					printItem,
				],
			};

			const layoutButtonSequenceOptions = Setting.enumOptions('layoutButtonSequence');
			const layoutButtonSequenceMenuItems = [];

			for (const value in layoutButtonSequenceOptions) {
				layoutButtonSequenceMenuItems.push({
					id: `layoutButtonSequence_${value}`,
					label: layoutButtonSequenceOptions[value],
					type: 'checkbox',
					click: () => {
						Setting.setValue('layoutButtonSequence', value);
					},
				});
			}

			const rootMenus: any = {
				edit: {
					id: 'edit',
					label: _('&Edit'),
					submenu: [
						menuItemDic.textCopy,
						menuItemDic.textCut,
						menuItemDic.textPaste,
						menuItemDic.textSelectAll,
						separator(),
						menuItemDic['editor.undo'],
						menuItemDic['editor.redo'],
						separator(),
						menuItemDic.textBold,
						menuItemDic.textItalic,
						menuItemDic.textLink,
						menuItemDic.textCode,
						separator(),
						menuItemDic.insertDateTime,
						menuItemDic.attachFile,
						separator(),
						menuItemDic['editor.deleteLine'],
						menuItemDic['editor.duplicateLine'],
						menuItemDic['editor.toggleComment'],
						menuItemDic['editor.sortSelectedLines'],
						menuItemDic['editor.indentLess'],
						menuItemDic['editor.indentMore'],
						menuItemDic['editor.swapLineDown'],
						menuItemDic['editor.swapLineUp'],
						separator(),
						menuItemDic.focusSearch,
						menuItemDic.showLocalSearch,
					],
				},
				view: {
					label: _('&View'),
					submenu: [
						menuItemDic.toggleLayoutMoveMode,
						separator(),
						menuItemDic.toggleSideBar,
						menuItemDic.toggleNoteList,
						menuItemDic.toggleVisiblePanes,
						{
							label: _('Layout button sequence'),
							submenu: layoutButtonSequenceMenuItems,
						},
						separator(),
						{
							label: Setting.settingMetadata('notes.sortOrder.field').label(),
							submenu: sortNoteItems,
						}, {
							label: Setting.settingMetadata('folders.sortOrder.field').label(),
							submenu: sortFolderItems,
						}, {
							id: 'showNoteCounts',
							label: Setting.settingMetadata('showNoteCounts').label(),
							type: 'checkbox',
							click: () => {
								Setting.setValue('showNoteCounts', !Setting.value('showNoteCounts'));
							},
						}, {
							id: 'uncompletedTodosOnTop',
							label: Setting.settingMetadata('uncompletedTodosOnTop').label(),
							type: 'checkbox',
							click: () => {
								Setting.setValue('uncompletedTodosOnTop', !Setting.value('uncompletedTodosOnTop'));
							},
						}, {
							id: 'showCompletedTodos',
							label: Setting.settingMetadata('showCompletedTodos').label(),
							type: 'checkbox',
							click: () => {
								Setting.setValue('showCompletedTodos', !Setting.value('showCompletedTodos'));
							},
						},
						separator(),
						{
							label: _('Actual Size'),
							click: () => {
								Setting.setValue('windowContentZoomFactor', 100);
							},
							accelerator: 'CommandOrControl+0',
						}, {
						// There are 2 shortcuts for the action 'zoom in', mainly to increase the user experience.
						// Most applications handle this the same way. These applications indicate Ctrl +, but actually mean Ctrl =.
						// In fact they allow both: + and =. On the English keyboard layout - and = are used without the shift key.
						// So to use Ctrl + would mean to use the shift key, but this is not the case in any of the apps that show Ctrl +.
						// Additionally it allows the use of the plus key on the numpad.
							label: _('Zoom In'),
							click: () => {
								Setting.incValue('windowContentZoomFactor', 10);
							},
							accelerator: 'CommandOrControl+Plus',
						}, {
							label: _('Zoom In'),
							visible: false,
							click: () => {
								Setting.incValue('windowContentZoomFactor', 10);
							},
							accelerator: 'CommandOrControl+=',
						}, {
							label: _('Zoom Out'),
							click: () => {
								Setting.incValue('windowContentZoomFactor', -10);
							},
							accelerator: 'CommandOrControl+-',
						}],
				},
				go: {
					label: _('&Go'),
					submenu: [
						menuItemDic.historyBackward,
						menuItemDic.historyForward,
						separator(),
						{
							label: _('Focus'),
							submenu: focusItems,
						},
					],
				},
				folder: {
					label: _('Note&book'),
					submenu: [
						menuItemDic.showShareFolderDialog,
					],
				},
				note: {
					label: _('&Note'),
					submenu: [
						menuItemDic.toggleExternalEditing,
						menuItemDic.setTags,
						menuItemDic.showShareNoteDialog,
						separator(),
						menuItemDic.showNoteContentProperties,
					],
				},
				tools: {
					label: _('&Tools'),
					submenu: toolsItems,
				},
				help: {
					label: _('&Help'),
					role: 'help', // Makes it add the "Search" field on macOS
					submenu: [{
						label: _('Website and documentation'),
						accelerator: keymapService.getAccelerator('help'),
						click() { bridge().openExternal('https://joplinapp.org'); },
					}, {
						label: _('Joplin Forum'),
						click() { bridge().openExternal('https://discourse.joplinapp.org'); },
					}, {
						label: _('Make a donation'),
						click() { bridge().openExternal('https://joplinapp.org/donate/'); },
					}, {
						label: _('Check for updates...'),
						visible: shim.isMac() ? false : true,
						click: () => _checkForUpdates(),
					},
					separator(),
					syncStatusItem,
					separator(),
					{
						id: 'help:toggleDevTools',
						label: _('Toggle development tools'),
						click: () => {
							props.dispatch({
								type: 'NOTE_DEVTOOLS_TOGGLE',
							});
						},
					},

					menuItemDic.toggleSafeMode,
					menuItemDic.openProfileDirectory,
					menuItemDic.copyDevCommand,

					{
						type: 'separator',
						visible: shim.isMac() ? false : true,
					}, {
						label: _('About Joplin'),
						visible: shim.isMac() ? false : true,
						click: () => _showAbout(),
					}],
				},
			};

			if (shim.isMac()) {
				rootMenus.macOsApp = rootMenuFile;
				rootMenus.file = rootMenuFileMacOs;
			} else {
				rootMenus.file = rootMenuFile;
			}

			// It seems the "visible" property of separators is ignored by Electron, making
			// it display separators that we want hidden. So this function iterates through
			// them and remove them completely.
			const cleanUpSeparators = (items: any[]) => {
				const output = [];
				for (const item of items) {
					if ('visible' in item && item.type === 'separator' && !item.visible) continue;
					output.push(item);
				}
				return output;
			};

			for (const key in rootMenus) {
				if (!rootMenus.hasOwnProperty(key)) continue;
				if (!rootMenus[key].submenu) continue;
				rootMenus[key].submenu = cleanUpSeparators(rootMenus[key].submenu);
			}

			{
				// This is for GotoAnything only - should be refactored since this plugin manager is not used otherwise
				const pluginMenuItems = PluginManager.instance().menuItems();
				for (const item of pluginMenuItems) {
					const itemParent = rootMenus[item.parent] ? rootMenus[item.parent] : 'tools';
					itemParent.submenu.push(separator());
					itemParent.submenu.push(item);
				}
			}

			for (const view of props.pluginMenuItems) {
				const location: MenuItemLocation = view.location;
				if (isContextMenuItemLocation(location)) continue;

				const itemParent = rootMenus[location];

				if (!itemParent) {
					reg.logger().error('Menu item location does not exist: ', location, view);
				} else {
					itemParent.submenu.push(menuItemDic[view.commandName]);
				}
			}

			for (const view of props.pluginMenus) {
				if (isContextMenuItemLocation(view.location)) continue;
				const itemParent = rootMenus[view.location];

				if (!itemParent) {
					reg.logger().error('Menu location does not exist: ', location, view);
				} else {
					itemParent.submenu.push(createPluginMenuTree(view.label, view.menuItems, (commandName: string) => onMenuItemClickRef.current(commandName)));
				}
			}

			const template = [
				rootMenus.file,
				rootMenus.edit,
				rootMenus.view,
				rootMenus.go,
				rootMenus.folder,
				rootMenus.note,
				rootMenus.tools,
				rootMenus.help,
			];

			if (shim.isMac()) template.splice(0, 0, rootMenus.macOsApp);

			if (props.routeName !== 'Main') {
				setMenu(Menu.buildFromTemplate([
					{
						label: _('&File'),
						submenu: [quitMenuItem],
					},
					{
						label: _('&Edit'),
						submenu: [
							menuItemDic.textCopy,
							menuItemDic.textCut,
							menuItemDic.textPaste,
							menuItemDic.textSelectAll,
						],
					},
				]));
			} else {
				setMenu(Menu.buildFromTemplate(template));
			}
		}

		timeoutId = setTimeout(updateMenu, 50);

		return () => {
			clearTimeout(timeoutId);
			timeoutId = null;
		};
	}, [props.routeName, props.pluginMenuItems, props.pluginMenus, keymapLastChangeTime, modulesLastChangeTime, props['spellChecker.language'], props['spellChecker.enabled'], props.plugins, props.customCss]);

	useMenuStates(menu, props);

	useEffect(() => {
		function onKeymapChange() {
			setKeymapLastChangeTime(Date.now());
		}

		KeymapService.instance().on('keymapChange', onKeymapChange);

		return () => {
			KeymapService.instance().off('keymapChange', onKeymapChange);
		};
	}, []);

	useEffect(() => {
		function onModulesChanged() {
			setModulesLastChangeTime(Date.now());
		}

		InteropService.instance().on('modulesChanged', onModulesChanged);

		return () => {
			InteropService.instance().off('modulesChanged', onModulesChanged);
		};
	}, []);

	return menu;
}

function MenuBar(props: Props): any {
	const menu = useMenu(props);
	if (menu) Menu.setApplicationMenu(menu);
	return null;
}

const mapStateToProps = (state: AppState) => {
	const whenClauseContext = stateToWhenClauseContext(state);

	return {
		menuItemProps: menuUtils.commandsToMenuItemProps(commandNames.concat(pluginCommandNames(state.pluginService.plugins)), whenClauseContext),
		routeName: state.route.routeName,
		selectedFolderId: state.selectedFolderId,
		layoutButtonSequence: state.settings.layoutButtonSequence,
		['notes.sortOrder.field']: state.settings['notes.sortOrder.field'],
		['folders.sortOrder.field']: state.settings['folders.sortOrder.field'],
		['notes.sortOrder.reverse']: state.settings['notes.sortOrder.reverse'],
		['folders.sortOrder.reverse']: state.settings['folders.sortOrder.reverse'],
		showNoteCounts: state.settings.showNoteCounts,
		uncompletedTodosOnTop: state.settings.uncompletedTodosOnTop,
		showCompletedTodos: state.settings.showCompletedTodos,
		pluginMenuItems: stateUtils.selectArrayShallow({ array: pluginUtils.viewsByType(state.pluginService.plugins, 'menuItem') }, 'menuBar.pluginMenuItems'),
		pluginMenus: stateUtils.selectArrayShallow({ array: pluginUtils.viewsByType(state.pluginService.plugins, 'menu') }, 'menuBar.pluginMenus'),
		['spellChecker.language']: state.settings['spellChecker.language'],
		['spellChecker.enabled']: state.settings['spellChecker.enabled'],
		plugins: state.pluginService.plugins,
		customCss: state.customCss,
	};
};

export default connect(mapStateToProps)(MenuBar);
