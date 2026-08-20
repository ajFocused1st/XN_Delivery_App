
        // --- Global Variables ---
        let currentStep = 1;
        const totalSteps = 4;
        let stopCounter = 2;
        let packageCounter = 1;
        let distanceService;
        let geocoder;
        let calculatedTotalMiles = 0;

        // --- Initialization ---
        function initializeMapsServices() {
            if (typeof google !== 'undefined' && google.maps && google.maps.places && google.maps.DistanceMatrixService) {
                try {
                    distanceService = new google.maps.DistanceMatrixService();
                    geocoder = new google.maps.Geocoder();
                    initAutocompleteForExisting();
                    showStep(currentStep);
                    console.log("Google Maps Services Initialized.");
                    return true;
                } catch (error) {
                    console.error("Error initializing Google Maps Services:", error);
                    disableFormForMapsFailure('Error: Mapping services could not be loaded. Please try again later.');
                    return false;
                }
            } else {
                console.error("Google Maps script failed to load, core services not available, OR API key is invalid/missing.");
                disableFormForMapsFailure('Error: Mapping services could not be loaded. Please try again later.');
                return false;
            }
        // ========== PACKAGE FILE UPLOADS ==========
        function createUploadToken() {
          if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
          }
          return `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        }

        function updateUploadStatusMessage(input, state, customMessage) {
          const statusEl = input?.closest('.package-group')?.querySelector('[data-upload-status]');
          if (!statusEl) return;
          statusEl.classList.remove('upload-status--success', 'upload-status--error');
          let message = customMessage;
          if (!message) {
            if (state === 'uploading') {
              message = 'Uploading...';
            } else if (state === 'uploaded') {
              message = 'Upload complete.';
            } else if (state === 'error') {
              message = 'Upload failed.';
            } else if (input?.files?.length) {
              message = input.files[0].name;
            } else {
              message = 'No file selected.';
            }
          }
          statusEl.textContent = message;
          if (state === 'uploaded') {
            statusEl.classList.add('upload-status--success');
          } else if (state === 'error') {
            statusEl.classList.add('upload-status--error');
          }
        }

        function preparePackageUploadInput(input) {
          if (!input) return;
          if (!input.dataset.uploadToken) {
            input.dataset.uploadToken = createUploadToken();
          }
          if (!input.dataset.uploadStatus) {
            input.dataset.uploadStatus = (input.files && input.files.length) ? 'pending' : 'idle';
          }
          if (!input.dataset.uploadHandlerBound) {
            input.addEventListener('change', (event) => {
              handlePackageFileChange(event).catch((error) => {
                console.error('Package upload error:', error);
              });
            });
            input.dataset.uploadHandlerBound = 'true';
          }
          updateUploadStatusMessage(input, input.dataset.uploadStatus);
        }

        function initializePackageUploadHandlers() {
          document.querySelectorAll('.pkg-upload').forEach((input) => preparePackageUploadInput(input));
        }

        function getAttachmentMetaForInput(uploadInput) {
          if (!uploadInput) {
            return { status: 'none', label: 'None', attachment: null };
          }
          const token = uploadInput.dataset.uploadToken;
          const storedAttachment = token ? packageUploadState.get(token) : null;
          if (storedAttachment) {
            return {
              status: 'uploaded',
              label: storedAttachment.originalName || 'Attachment',
              url: storedAttachment.publicUrl || null,
              attachment: storedAttachment,
            };
          }
          if (uploadInput.dataset.uploadStatus === 'uploading') {
            const name = uploadInput.files && uploadInput.files[0] ? uploadInput.files[0].name : 'Uploading...';
            return { status: 'uploading', label: name, attachment: null };
          }
          if (uploadInput.dataset.uploadStatus === 'error') {
            const failedName = uploadInput.files && uploadInput.files[0] ? uploadInput.files[0].name : 'Upload failed';
            return { status: 'error', label: failedName, attachment: null };
          }
          if (uploadInput.files && uploadInput.files.length > 0) {
            return { status: 'pending', label: uploadInput.files[0].name, attachment: null };
          }
          return { status: 'none', label: 'None', attachment: null };
        }

        async function handlePackageFileChange(event) {
          const input = event.target;
          if (!input) return;
          const token = input.dataset.uploadToken || createUploadToken();
          input.dataset.uploadToken = token;

          const files = input.files;
          if (!files || files.length === 0) {
            packageUploadState.delete(token);
            input.dataset.uploadStatus = 'idle';
            updateUploadStatusMessage(input, 'idle');
            return;
          }

          const file = files[0];
          if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES_FRONT) {
            packageUploadState.delete(token);
            input.dataset.uploadStatus = 'error';
            const limitMb = (MAX_UPLOAD_FILE_SIZE_BYTES_FRONT / (1024 * 1024)).toFixed(1);
            updateUploadStatusMessage(input, 'error', `Too large: exceeds ${limitMb} MB.`);
            alert(`The selected file is larger than ${limitMb} MB. Please choose a smaller file.`);
            input.value = '';
            return;
          }

          input.dataset.uploadStatus = 'uploading';
          updateUploadStatusMessage(input, 'uploading', `Uploading ${file.name}...`);

          try {
            const presignData = await requestPresignedUpload(file);
            await uploadFileToSignedUrl(presignData.uploadUrl, file);
            const metadata = {
              storageKey: presignData.fileKey,
              publicUrl: presignData.publicUrl || null,
              originalName: file.name,
              mimeType: file.type || 'application/octet-stream',
              size: file.size,
              uploadedAt: new Date().toISOString(),
            };
            packageUploadState.set(token, metadata);
            input.dataset.uploadStatus = 'uploaded';
            updateUploadStatusMessage(input, 'uploaded', `Uploaded: ${file.name}`);
          } catch (error) {
            console.error('Package upload failed:', error);
            packageUploadState.delete(token);
            input.dataset.uploadStatus = 'error';
            updateUploadStatusMessage(input, 'error', error.message || 'Upload failed.');
            alert(error.message || 'Unable to upload file. Please try again.');
            input.value = '';
          }
        }

        async function requestPresignedUpload(file) {
          const response = await fetch(UPLOADS_PRESIGN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: file.name,
              fileType: file.type || 'application/octet-stream',
              fileSize: file.size,
            }),
          });

          let data = {};
          try {
            data = await response.json();
          } catch (error) {
            console.warn('Failed to parse presign response as JSON:', error);
          }

          if (!response.ok) {
            const message = data?.message || `Upload preparation failed (${response.status})`;
            throw new Error(message);
          }

          if (!data?.uploadUrl || !data?.fileKey) {
            throw new Error('Upload service returned an invalid response.');
          }

          return data;
        }

        async function uploadFileToSignedUrl(url, file) {
          const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          });
          if (!response.ok) {
            throw new Error(`Upload failed with status ${response.status}`);
          }
        }

        function ensurePackageUploadsComplete() {
          const uploadingInput = Array.from(document.querySelectorAll('.pkg-upload')).find((input) => input.dataset.uploadStatus === 'uploading');
          if (uploadingInput) {
            throw new Error('Please wait for all package file uploads to finish.');
          }
        }

        function parseFloatOrNull(value) {
          if (value === undefined || value === null || value === '') return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }

        function collectPackagesData() {
          const packageGroups = document.querySelectorAll('.package-group');
          if (!packageGroups.length) {
            return [];
          }

          ensurePackageUploadsComplete();

          const packages = [];
          packageGroups.forEach((group) => {
            const uploadInput = group.querySelector('.pkg-upload');
            const attachmentMeta = getAttachmentMetaForInput(uploadInput);
            if (attachmentMeta.status === 'error') {
              throw new Error(`File upload failed for ${attachmentMeta.label}. Please retry the upload or remove the file.`);
            }
            if (uploadInput && uploadInput.files && uploadInput.files.length > 0 && attachmentMeta.status !== 'uploaded') {
              throw new Error(`File upload is still pending for ${attachmentMeta.label || uploadInput.files[0].name}.`);
            }
            const attachment = attachmentMeta.attachment ? { ...attachmentMeta.attachment } : null;

            const qtyValue = parseInt(group.querySelector('.pkg-qty')?.value || '0', 10);
            const descValue = (group.querySelector('.pkg-desc')?.value || '').trim();
            const weightValue = parseFloatOrNull(group.querySelector('.pkg-weight')?.value);
            const lengthValue = parseFloatOrNull(group.querySelector('.pkg-length')?.value);
            const widthValue = parseFloatOrNull(group.querySelector('.pkg-width')?.value);
            const heightValue = parseFloatOrNull(group.querySelector('.pkg-height')?.value);
            const unitValue = (group.querySelector('.pkg-unit')?.value || 'inches').trim();
            const fileName = attachment?.originalName || (uploadInput && uploadInput.files && uploadInput.files[0] ? uploadInput.files[0].name : null);

            packages.push({
              qty: Number.isFinite(qtyValue) && qtyValue > 0 ? qtyValue : 0,
              desc: descValue,
              weight: weightValue,
              length: lengthValue,
              width: widthValue,
              height: heightValue,
              unit: unitValue,
              fileName,
              attachment,
            });
          });

          return packages;

        }
        // ========== STEP NAVIGATION & VALIDATION ==========
        function showStep(stepNumber) {
          document.querySelectorAll('.form-step').forEach(step => step.classList.remove('active'));
          const currentStepDiv = document.getElementById(`step-${stepNumber}`);
          if (currentStepDiv) {
              currentStepDiv.classList.add('active');
              currentStepDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        function validateStep(stepNumber) {
             let isValid = true;
             const currentStepDiv = document.getElementById(`step-${stepNumber}`);
             if (!currentStepDiv) return false;
             currentStepDiv.querySelectorAll('.error-border').forEach(el => el.classList.remove('error-border'));
             currentStepDiv.querySelectorAll('input[required], select[required], textarea[required]').forEach(input => {
                 input.style.borderColor = '#ccc';
                 let value = input.value;
                 if ( (input.type === 'checkbox' && !input.checked && input.required) ||
                      (!value || !value.trim()) && input.type !== 'checkbox' && input.required) {
                     isValid = false;
                     input.style.borderColor = 'red';
                     if(input.type === 'checkbox') input.closest('div').classList.add('error-border');
                  }
                 else if (input.type === 'number' && input.min !== '' && parseFloat(value) < parseFloat(input.min)) {
                     isValid = false; input.style.borderColor = 'red';
                  }
                 else if (input.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                      isValid = false; input.style.borderColor = 'red';
                  }
             });
             if (stepNumber === 1) {
                 const stops = currentStepDiv.querySelectorAll('.stop-addr');
                 if (stops.length < 2) isValid = false;
                 currentStepDiv.querySelectorAll('.address-group').forEach(group => {
                     const stairsCheck = group.querySelector('.stairs-check');
                     const floorInput = group.querySelector('.floor-count');
                     const loadUnloadSelect = group.querySelector('.load-unload-select');
                     if (stairsCheck && stairsCheck.checked && floorInput && (!floorInput.value || !floorInput.value.trim() || parseInt(floorInput.value) < 1)) {
                          isValid = false; floorInput.style.borderColor = 'red';
                     } else if (floorInput && floorInput.style.borderColor === 'red') {
                           if (!isNaN(parseInt(floorInput.value)) && parseInt(floorInput.value) >= 1) floorInput.style.borderColor = '#ccc';
                     }
                     if (loadUnloadSelect && !loadUnloadSelect.value) {
                         isValid = false; loadUnloadSelect.style.borderColor = 'red';
                     }
                 });
                 if (!isValid) {
                     if (stops.length < 2) alert("Please enter at least two stops (e.g., one pickup and one dropoff).");
                     else alert('Please ensure all stop addresses are filled, a load/unload responsibility is selected, and enter the floor number (1 or higher) when stairs are indicated.');
                  }
             } else if (stepNumber === 2) {
                 currentStepDiv.querySelectorAll('.package-group').forEach(group => {
                     let packageValid = true;
                     group.querySelectorAll('input[type="number"][required].pkg-weight, input[type="number"][required].pkg-length, input[type="number"][required].pkg-width, input[type="number"][required].pkg-height').forEach(numInput => {
                         if (numInput.value && parseFloat(numInput.value) < 0) {
                             packageValid = false; numInput.style.borderColor = 'red';
                         }
                     });
                     if (!packageValid) { isValid = false; alert('Package weights and dimensions cannot be negative.'); }
                 });
             }
             if (!isValid && stepNumber > 1 && stepNumber !== 2) {
                 alert('Please fill out all required fields correctly (highlighted in red).');
             }
             return isValid;
         }
        function goToNextStep(stepNumber) {
           if (stepNumber === 1) {
               let contactValid = true;
               document.querySelectorAll('#contactName, #contactEmail').forEach(input => {
                   input.style.borderColor = '#ccc';
                   if (!input.value || !input.value.trim()) { contactValid = false; input.style.borderColor = 'red';
                   } else if (input.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value)) {
                       contactValid = false; input.style.borderColor = 'red';
                   }
               });
               if (!contactValid) {
                   alert('Please fill in the required Contact Name and provide a valid Email before proceeding.');
                   document.querySelector('fieldset').scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
               }
           }
           if (!validateStep(stepNumber)) return;
          currentStep = stepNumber + 1;
          showStep(currentStep);
          if (currentStep === 4) buildSummary();
        }
        function goToPrevStep(stepNumber) {
          currentStep = stepNumber - 1;
          showStep(currentStep);
        }


        // ========== ADDRESS/STOP MANAGEMENT ==========
         function addAddress() {
          const addressContainer = document.getElementById('addressContainer');
          const newStopIndex = addressContainer.children.length + 1;
          stopCounter = newStopIndex;
          const group = document.createElement('div');
          group.className = 'address-group';
          const stopInputId = `stopAddr${newStopIndex}`;
          const loadUnloadId = `loadUnload${newStopIndex}`;
          const stairsCheckId = `stairsCheck${newStopIndex}`;
          const floorCountId = `floorCount${newStopIndex}`;
          group.innerHTML = `
            <button type="button" class="remove-button" onclick="removeGroup(this)">Remove</button>
            <label for="${stopInputId}">Stop ${newStopIndex} Address:</label>
            <input type="text" id="${stopInputId}" class="address-input stop-addr" placeholder="Enter address for stop ${newStopIndex}" required />
            <label for="${loadUnloadId}">Load/Unload Responsibility:</label>
            <select id="${loadUnloadId}" class="load-unload-select" required>
                <option value="">-- Select Responsibility --</option>
                <option value="customer">Customer</option>
                <option value="driver">Driver</option>
                <option value="driver_assist">Customer w/ Driver Assist</option>
            </select>
            <div>
                <input type="checkbox" id="${stairsCheckId}" class="stairs-check" onchange="toggleFloorInput(this)">
                <label for="${stairsCheckId}" class="inline-label">Steps/Stairs involved?</label>
            </div>
            <div class="floor-input-div" style="display:none;">
                <label for="${floorCountId}">Floor Number:</label>
                <input type="number" id="${floorCountId}" class="floor-count" min="1" placeholder="Floor #">
            </div>
          `;
          addressContainer.appendChild(group);
          initAutocompleteForFields(group.querySelectorAll('.address-input'));
        }
        function removeGroup(btn) {
          const group = btn.closest('.address-group, .package-group');
          const container = group.parentNode;
          if (container.id === 'packageContainer' && container.children.length <= 1) { alert("You must have at least one package."); return; }
           if (container.id === 'addressContainer' && container.children.length <= 2) { alert("You need at least two stops (a pickup and a dropoff)."); return; }
          if (container.id === 'packageContainer') {
            const uploadInput = group.querySelector('.pkg-upload');
            const token = uploadInput?.dataset?.uploadToken;
            if (token) {
              packageUploadState.delete(token);
            }
          }
          group.remove();
          if (container.id === 'addressContainer') renumberStops();
          if (container.id === 'packageContainer') renumberPackages();
        }
        function renumberStops() {
             const addressContainer = document.getElementById('addressContainer');
             const allStopGroups = addressContainer.querySelectorAll('.address-group');
             allStopGroups.forEach((group, index) => {
                 const stopNumber = index + 1;
                 const labelAddr = group.querySelector('label[for^="stopAddr"]');
                 const inputAddr = group.querySelector('.stop-addr');
                 const labelLoad = group.querySelector('label[for^="loadUnload"]');
                 const selectLoad = group.querySelector('.load-unload-select');
                 const stairsCheck = group.querySelector('.stairs-check');
                 const stairsLabel = stairsCheck ? stairsCheck.nextElementSibling : null;
                 const floorLabel = group.querySelector('.floor-input-div label');
                 const floorInput = group.querySelector('.floor-count');
                 const removeBtn = group.querySelector('.remove-button');
                 const stopInputId = `stopAddr${stopNumber}`;
                 const loadUnloadId = `loadUnload${stopNumber}`;
                 const stairsCheckId = `stairsCheck${stopNumber}`;
                 const floorCountId = `floorCount${stopNumber}`;
                 if(labelAddr) { labelAddr.textContent = `Stop ${stopNumber} Address:`; labelAddr.htmlFor = stopInputId; }
                 if(inputAddr) { inputAddr.id = stopInputId; inputAddr.placeholder = `Enter address for stop ${stopNumber}`; }
                 if(labelLoad) { labelLoad.htmlFor = loadUnloadId; }
                 if(selectLoad) { selectLoad.id = loadUnloadId; }
                 if (stairsCheck) stairsCheck.id = stairsCheckId;
                 if(stairsLabel) stairsLabel.htmlFor = stairsCheckId;
                 if (floorLabel && floorInput) floorLabel.htmlFor = floorCountId;
                 if (floorInput) floorInput.id = floorCountId;
                 if(removeBtn) removeBtn.style.display = (stopNumber <= 1) ? 'none' : 'block';
             });
             stopCounter = allStopGroups.length;
         }
         function toggleFloorInput(checkbox) {
            const group = checkbox.closest('.address-group');
            const floorDiv = group.querySelector('.floor-input-div');
            const floorInput = group.querySelector('.floor-count');
            if (!group || !floorDiv || !floorInput) return;
            if (checkbox.checked) {
              floorDiv.style.display = 'block'; floorInput.required = true; floorInput.value = floorInput.value || '1';
            } else {
              floorDiv.style.display = 'none'; floorInput.required = false; floorInput.value = ''; floorInput.style.borderColor = '#ccc';
            }
          }
        function initAutocompleteForExisting() {
          const existingInputs = document.querySelectorAll('.address-input');
          initAutocompleteForFields(existingInputs);
        }
        function initAutocompleteForFields(inputs) {
           if (typeof google === 'undefined' || !google.maps || !google.maps.places) { console.warn("Google Places library not ready for autocomplete initialization."); return; }
          inputs.forEach((input) => {
            if (input.dataset.autocompleteInitialized) return;
            try {
                 const autocomplete = new google.maps.places.Autocomplete(input, { types: ['address'] });
                 input.dataset.autocompleteInitialized = 'true';
                 autocomplete.addListener('place_changed', () => { input.style.borderColor = '#ccc'; });
            } catch (error) {
                 console.error("Error initializing autocomplete for input:", input, error);
                 input.placeholder = "Autocomplete failed to load"; input.style.backgroundColor = "#fff0f0";
            }
          });
        }


        // ========== PACKAGE MANAGEMENT ==========
        function addPackage() {
            packageCounter++;
            const pkgContainer = document.getElementById('packageContainer');
            const pkgGroup = document.createElement('div');
            pkgGroup.className = 'package-group';
            const qtyId = `pkgQty${packageCounter}`;
            const descId = `pkgDesc${packageCounter}`;
            const weightId = `pkgWeight${packageCounter}`;
            const lengthId = `pkgLength${packageCounter}`;
            const widthId = `pkgWidth${packageCounter}`;
            const heightId = `pkgHeight${packageCounter}`;
            const unitId = `pkgUnit${packageCounter}`;
            const uploadId = `pkgUpload${packageCounter}`; // New ID for file upload

            pkgGroup.innerHTML = `
            <button type="button" class="remove-button" onclick="removeGroup(this)">Remove</button>
            <div class="inline-group"> <label for="${qtyId}">Qty:</label> <input type="number" id="${qtyId}" class="pkg-qty" min="1" value="1" required style="width: 70px; margin-right: 15px;"> <label for="${descId}" style="flex-grow: 1;">Description:</label> </div>
            <textarea id="${descId}" class="pkg-desc" rows="2" placeholder="Describe item(s)" required></textarea>
            <label for="${weightId}">Weight (lbs per item):</label> <input type="number" id="${weightId}" class="pkg-weight" min="0" step="0.1" placeholder="Weight per item in lbs" required />
             <small style="display: block; margin-top: -3px; margin-bottom: 10px; color: #6c757d;">Weight cost: $0.03 per pound (total weight).</small>
            <label>Dimensions (L x W x H per item):</label>
            <div class="inline-group"> <input type="number" id="${lengthId}" class="pkg-length dimension-input" min="0" step="0.1" placeholder="L" required title="Length" /> <span>x</span> <input type="number" id="${widthId}" class="pkg-width dimension-input" min="0" step="0.1" placeholder="W" required title="Width"/> <span>x</span> <input type="number" id="${heightId}" class="pkg-height dimension-input" min="0" step="0.1" placeholder="H" required title="Height"/> <select id="${unitId}" class="pkg-unit" required title="Dimension Unit"> <option value="inches" selected>Inches</option> <option value="feet">Feet</option> </select> </div>
            <label for="${uploadId}" class="optional">Upload Image/Doc (Optional):</label>
            <input type="file" id="${uploadId}" class="pkg-upload" accept="image/*,application/pdf,.doc,.docx,.txt">
            <small class="upload-status" data-upload-status>No file selected.</small>
            `;
            pkgContainer.appendChild(pkgGroup);
            const uploadInput = pkgGroup.querySelector('.pkg-upload');
            if (uploadInput) {
              preparePackageUploadInput(uploadInput);
            }
            renumberPackages();
        }
        function renumberPackages() {
             const pkgContainer = document.getElementById('packageContainer');
             const allPkgGroups = pkgContainer.querySelectorAll('.package-group');
             allPkgGroups.forEach((group, index) => {
                 const pkgNumber = index + 1;
                 const qtyId = `pkgQty${pkgNumber}`; const descId = `pkgDesc${pkgNumber}`; const weightId = `pkgWeight${pkgNumber}`;
                 const lengthId = `pkgLength${pkgNumber}`; const widthId = `pkgWidth${pkgNumber}`; const heightId = `pkgHeight${pkgNumber}`; const unitId = `pkgUnit${pkgNumber}`;
                 const uploadId = `pkgUpload${pkgNumber}`; // Renumber file upload
                 group.querySelector('label[for^="pkgQty"]')?.setAttribute('for', qtyId); group.querySelector('.pkg-qty')?.setAttribute('id', qtyId);
                 group.querySelector('label[for^="pkgDesc"]')?.setAttribute('for', descId); group.querySelector('.pkg-desc')?.setAttribute('id', descId);
                 group.querySelector('label[for^="pkgWeight"]')?.setAttribute('for', weightId); group.querySelector('.pkg-weight')?.setAttribute('id', weightId);
                 group.querySelector('.pkg-length')?.setAttribute('id', lengthId); group.querySelector('.pkg-width')?.setAttribute('id', widthId);
                 group.querySelector('.pkg-height')?.setAttribute('id', heightId); group.querySelector('.pkg-unit')?.setAttribute('id', unitId);
                 group.querySelector('label[for^="pkgUpload"]')?.setAttribute('for', uploadId);
                const uploadInput = group.querySelector('.pkg-upload');
                if (uploadInput) {
                  uploadInput.setAttribute('id', uploadId);
                  preparePackageUploadInput(uploadInput);
                }
                 const removeBtn = group.querySelector('.remove-button'); if(removeBtn) removeBtn.style.display = (pkgNumber === 1) ? 'none' : 'block';
             });
             packageCounter = allPkgGroups.length;
         }


        // ========== BUILD SUMMARY (For HTML Display) ==========
        function buildSummary() {
          const summaryDiv = document.getElementById('summaryContainer');
          summaryDiv.innerHTML = '';
          const contactName = document.getElementById('contactName')?.value || 'N/A';
          const contactEmail = document.getElementById('contactEmail')?.value || 'N/A';
          const contactPhone = document.getElementById('contactPhone')?.value || '';
          const contactCompany = document.getElementById('contactCompany')?.value || '';
           let contactSummary = `<h4>Contact Information</h4><p>Name: ${contactName}</p><p>Email: ${contactEmail}</p>`;
            if (contactPhone) contactSummary += `<p>Phone: ${contactPhone}</p>`;
            if (contactCompany) contactSummary += `<p>Company: ${contactCompany}</p>`;
          const stops = document.querySelectorAll('.address-group');
          let addressSummary = '<h4>Stops</h4>';
          if (stops.length < 2) { addressSummary += '<p>Please enter at least 2 stops.</p>'; }
          else { stops.forEach((stopGroup, i) => {
                    const addressInput = stopGroup.querySelector('.stop-addr');
                    const loadUnloadSelect = stopGroup.querySelector('.load-unload-select');
                    const stairsCheck = stopGroup.querySelector('.stairs-check');
                    const floorInput = stopGroup.querySelector('.floor-count');
                    let addressText = addressInput ? addressInput.value : 'N/A';
                    addressSummary += `<p><strong>Stop ${i + 1}:</strong> ${addressText}`;
                    let loadUnloadText = 'N/A';
                    if (loadUnloadSelect && loadUnloadSelect.selectedOptions.length > 0 && loadUnloadSelect.value !== "") { loadUnloadText = loadUnloadSelect.selectedOptions[0].text; }
                    addressSummary += ` (Load/Unload: ${loadUnloadText})`;
                    if (stairsCheck && stairsCheck.checked) { let floorValue = (floorInput && floorInput.value) ? floorInput.value : 'Not specified'; addressSummary += ` (Stairs: Yes, Floor: ${floorValue})`; }
                    else { addressSummary += ` (Stairs: No)`; }
                    addressSummary += `</p>`; });
          }
           const packageGroups = document.querySelectorAll('.package-group');
           let pkgSummary = '<h4>Packages</h4>';
            if (packageGroups.length === 0) { pkgSummary += '<p>No packages added.</p>'; }
            else {
              packageGroups.forEach((pkgGroup, j) => {
                const pkgQty = pkgGroup.querySelector('.pkg-qty')?.value || '1';
                const pkgDesc = pkgGroup.querySelector('.pkg-desc')?.value || 'N/A';
                const pkgWeight = pkgGroup.querySelector('.pkg-weight')?.value || '0';
                const pkgLength = pkgGroup.querySelector('.pkg-length')?.value || '0';
                const pkgWidth = pkgGroup.querySelector('.pkg-width')?.value || '0';
                const pkgHeight = pkgGroup.querySelector('.pkg-height')?.value || '0';
                const pkgUnit = pkgGroup.querySelector('.pkg-unit')?.value || 'inches';
                const attachmentMeta = getAttachmentMetaForInput(pkgGroup.querySelector('.pkg-upload'));
                let attachmentHtml = attachmentMeta.label || 'None';
                if (attachmentMeta.status === 'uploaded' && attachmentMeta.url) {
                  attachmentHtml = `<a href="${attachmentMeta.url}" target="_blank" rel="noopener">${attachmentMeta.label}</a>`;
                } else if (attachmentMeta.status === 'uploading') {
                  attachmentHtml = `Uploading: ${attachmentMeta.label}`;
                } else if (attachmentMeta.status === 'pending') {
                  attachmentHtml = `Pending upload: ${attachmentMeta.label}`;
                }
                pkgSummary += `<p><strong>Package ${j + 1} (${pkgQty}x):</strong> ${pkgDesc}<br/>`;
                pkgSummary += `<span style="margin-left: 10px;">Wt(ea): ${pkgWeight} lbs, Dim(ea): ${pkgLength}x${pkgWidth}x${pkgHeight} ${pkgUnit}, Attachment: ${attachmentHtml}</span></p>`;
              });
            }
          const vehicleTypeSelect = document.getElementById('vehicleType');
          const vehicleTypeText = vehicleTypeSelect.value ? vehicleTypeSelect.options[vehicleTypeSelect.selectedIndex].text : 'N/A';
          const pickupDate = document.getElementById('pickupDate').value;
          const pickupTime = document.getElementById('pickupTime').value;
          const urgencySelect = document.getElementById('urgency');
          const urgencyText = urgencySelect.value ? urgencySelect.options[urgencySelect.selectedIndex].text : 'N/A'; // Display text without fee
          const specialNotes = document.getElementById('specialNotes')?.value || 'None';

          const insideDelivery = document.getElementById('insideDelivery').checked;
          const hazardousBio = document.getElementById('hazardousBio').checked;
          const fragileHandling = document.getElementById('fragileHandling').checked;
          const extraLaborer = document.getElementById('extraLaborer').checked;

          let extrasSummary = `<h4>Details & Services</h4><p>Vehicle: ${vehicleTypeText}</p><p>Pickup Date/Time: ${pickupDate || 'N/A'} ${pickupTime || 'N/A'}</p><p>Urgency: ${urgencyText}</p>`;
          extrasSummary += `<p>Special Notes: ${specialNotes}</p>`;
          extrasSummary += `<p>Inside Delivery: ${insideDelivery ? 'Yes' : 'No'}</p>`; // Removed fee display
          extrasSummary += `<p>Hazardous/Bio-Hazardous: ${hazardousBio ? 'Yes' : 'No'}</p>`; // Updated label, removed fee display
          extrasSummary += `<p>Fragile/Special Handling: ${fragileHandling ? 'Yes' : 'No'}</p>`; // New, removed fee display
          extrasSummary += `<p>Extra Laborer: ${extraLaborer ? 'Yes' : 'No'}</p>`; // Removed fee display
          extrasSummary += `<p id="summary-miles">Total Distance: Pending Calculation...</p>`;

          summaryDiv.innerHTML = contactSummary + addressSummary + pkgSummary + extrasSummary;
          document.getElementById('quoteResult').textContent = '';
          document.getElementById('bookNowBtn').style.display = 'none';
          document.getElementById('downloadSummaryBtn').style.display = 'none';
          document.getElementById('weightWarning').style.display = 'none'; // Hide warning
        }


        // ========== HELPER: GET DISTANCE ==========
        function getDistanceInMiles(origin, destination) {
            return new Promise((resolve, reject) => {
                if (!distanceService) return reject('Distance service not ready.');
                if (!origin || !destination) return reject('Missing origin or destination.');
                distanceService.getDistanceMatrix(
                    { origins: [origin], destinations: [destination], travelMode: google.maps.TravelMode.DRIVING, unitSystem: google.maps.UnitSystem.IMPERIAL, },
                    (response, status) => {
                        const element = response?.rows?.[0]?.elements?.[0];
                        if (status === 'OK' && element?.status === 'OK') {
                            const distanceMeters = element.distance.value;
                            if (typeof distanceMeters === 'number') resolve(distanceMeters / 1609.34);
                            else reject('Invalid distance data from Google');
                        } else {
                            const elementStatus = element?.status;
                            console.error('DistanceMatrix Error:', status, elementStatus, response);
                            if (status === 'REQUEST_DENIED' || element?.status === 'REQUEST_DENIED') reject(`Cannot get distance: API Key/Billing/Enablement issue.`);
                            else if (elementStatus === 'NOT_FOUND') reject(`Cannot get distance: Address not found.`);
                            else if (elementStatus === 'ZERO_RESULTS') reject(`Cannot get distance: No driving route found.`);
                            else reject(`Cannot get distance: Google API Error (${status || elementStatus || 'Unknown'})`);
                        }
                    }
                );
            });
        }


        // ========== QUOTE CALCULATION & DATA LOGGING TO BACKEND ==========
        async function calculateQuote() {
             if (!validateStep(1) || !validateStep(2) || !validateStep(3)) { return; }
             buildSummary(); // Call buildSummary to update the display before calculation
            const quoteResultEl = document.getElementById('quoteResult');
            const milesSummaryEl = document.getElementById('summary-miles');
            const bookBtn = document.getElementById('bookNowBtn');
            const downloadBtn = document.getElementById('downloadSummaryBtn');
            const weightWarningEl = document.getElementById('weightWarning');
            
            quoteResultEl.textContent = 'Calculating... Please Wait';
            milesSummaryEl.textContent = 'Total Distance: Calculating...';
            bookBtn.style.display = 'none'; downloadBtn.style.display = 'none';
            weightWarningEl.style.display = 'none'; // Hide warning initially
            bookBtn.disabled = true; downloadBtn.disabled = true;
            calculatedTotalMiles = 0;

            const stopGroups = document.querySelectorAll('.address-group');
            const stopsData = Array.from(stopGroups).map(group => ({
                address: group.querySelector('.stop-addr').value.trim(),
                loadUnload: group.querySelector('.load-unload-select').value,
                stairs: group.querySelector('.stairs-check').checked,
                floor: group.querySelector('.floor-count').value
            })).filter(stop => stop.address.length > 0);

            if (stopsData.length < 2) {
                alert("Need at least 2 valid stops to calculate a route.");
                quoteResultEl.textContent = 'Error: Not enough stops.';
                milesSummaryEl.textContent = 'Total Distance: N/A';
                return;
            }

            let totalMiles = 0;
            try {
                const stopAddresses = stopsData.map(s => s.address);
                for (let i = 0; i < stopAddresses.length - 1; i++) {
                    const distanceMiles = await getDistanceInMiles(stopAddresses[i], stopAddresses[i+1]);
                    if (typeof distanceMiles !== 'number' || isNaN(distanceMiles)) { throw new Error(`Invalid distance for leg ${i+1}`); }
                    totalMiles += distanceMiles;
                }
                calculatedTotalMiles = totalMiles;
                milesSummaryEl.textContent = `Total Distance: ${totalMiles.toFixed(1)} miles`; // Update summary again
                console.log(`Total Distance: ${totalMiles.toFixed(1)} miles`);
            } catch (error) {
                console.error(`Distance calc failed:`, error);
                milesSummaryEl.textContent = `Total Distance: Error`;
                quoteResultEl.textContent = (error instanceof Error) ? error.message : 'Error calculating distance.';
                return;
            }

            let finalQuote = 0;
            let totalWeight = 0;
            document.querySelectorAll('.package-group').forEach(pkgGroup => {
                const qty = parseInt(pkgGroup.querySelector('.pkg-qty')?.value || '1');
                const weightPerItem = parseFloat(pkgGroup.querySelector('.pkg-weight')?.value || '0');
                if (!isNaN(qty) && !isNaN(weightPerItem) && qty > 0 && weightPerItem >= 0) {
                    totalWeight += qty * weightPerItem;
                }
            });
            console.log("Total Weight for Quote:", totalWeight);

            // Max weight check
            if (totalWeight > 4000) {
                alert("Total weight exceeds the maximum limit of 4000 lbs. Please adjust package details.");
                quoteResultEl.textContent = 'Error: Weight limit exceeded.';
                return;
            }

            try {
                // --- NEW: Vehicle Mileage Rate Logic ---
                const vehicleType = document.getElementById('vehicleType').value;
                const vehicleSelect = document.getElementById('vehicleType');
                const vehicleText = vehicleSelect.options[vehicleSelect.selectedIndex].text;
                let mileageRate = 0;
                let maxWeight = 0;

                switch (vehicleType) {
                    case 'car': mileageRate = 0.80; maxWeight = 100; break;
                    case 'suv': mileageRate = 1.10; maxWeight = 300; break;
                    case 'pickup_truck': mileageRate = 1.25; maxWeight = 1000; break;
                    case 'cargo_van': mileageRate = 1.50; maxWeight = 2500; break;
                    case 'cargo_van_high_roof': mileageRate = 1.85; maxWeight = 3500; break;
                    case 'box_truck': mileageRate = 2.24; maxWeight = 4000; break;
                    default:
                        quoteResultEl.textContent = 'Error: Please select a valid vehicle type.';
                        return; // Stop the calculation
                }

                // --- NEW: Weight Capacity Warning ---
                if (totalWeight > maxWeight) {
                    weightWarningEl.textContent = `Warning: The total weight of ${totalWeight.toFixed(1)} lbs exceeds the typical capacity for a ${vehicleText}. Please verify your selection.`;
                    weightWarningEl.style.display = 'block';
                }

                let mileageCost = totalMiles * mileageRate;
                const weightCostRate = 0.03;
                let weightCost = totalWeight * weightCostRate;
                let totalLoadUnloadFee = 0;
                stopsData.forEach((stop) => {
                    let fee = 0; let driverFee = 0;
                    if (totalWeight > 0) {
                        if (totalWeight <= 50) driverFee = 5;
                        else if (totalWeight <= 250) driverFee = 10;
                        else if (totalWeight <= 500) driverFee = 15;
                        else if (totalWeight <= 1000) driverFee = 20;
                        else if (totalWeight <= 1500) driverFee = 30;
                        else if (totalWeight <= 2000) driverFee = 40;
                        else if (totalWeight <= 2500) driverFee = 50;
                        else driverFee = 60; // Max $60 for > 2500 lbs
                    }
                    if (stop.loadUnload === 'driver') fee = driverFee;
                    else if (stop.loadUnload === 'driver_assist') fee = driverFee / 2;
                    totalLoadUnloadFee += fee;
                });
                let totalStairCost = 0;
                stopsData.forEach(stop => { if (stop.stairs && stop.floor) { const floor = parseInt(stop.floor); if (!isNaN(floor) && floor > 1) totalStairCost += (floor - 1) * 5.00; } });
                
                let servicesMultiplier = 1.0; let flatServiceFees = 0;
                if (document.getElementById('insideDelivery').checked) servicesMultiplier += 0.05;
                if (document.getElementById('hazardousBio').checked) servicesMultiplier += 0.20; // Consolidated
                if (document.getElementById('fragileHandling').checked) servicesMultiplier += 0.05; // NEW Fragile fee (5%)
                if (document.getElementById('extraLaborer').checked) flatServiceFees += 35.00;
                
                const urgency = document.getElementById('urgency').value;
                let urgencyPremium = 0;
                if (urgency === 'asap_2hr') urgencyPremium = 65.00;
                else if (urgency === 'expedited_4hr') urgencyPremium = 50.00;
                else if (urgency === 'late_night') urgencyPremium = 75.00;
                
                const numStops = stopsData.length; let additionalStopFee = 0;
                if (numStops > 2) additionalStopFee = (numStops - 2) * 3.50;
                
                const baseCost = mileageCost + weightCost;
                const costAfterMultiplier = baseCost * servicesMultiplier;
                const totalCost = costAfterMultiplier + totalLoadUnloadFee + totalStairCost + flatServiceFees + urgencyPremium + additionalStopFee;
                finalQuote = Math.max(0, totalCost);

                quoteResultEl.textContent = `Estimated Quote: $${finalQuote.toFixed(2)}`;
                bookBtn.style.display = 'inline-block'; downloadBtn.style.display = 'inline-block';
                bookBtn.disabled = false; downloadBtn.disabled = false;
                bookBtn.dataset.quoteAmount = finalQuote.toFixed(2);

            } catch (error) { console.error("Cost calc error:", error); quoteResultEl.textContent = 'Error calculating cost.'; return; }

            // --- Send Data to Backend for Logging Calculated Quote ---
            if (finalQuote >= 0 && quoteResultEl.textContent.startsWith("Estimated Quote")) {
                try {
                    // *** IMPORTANT: Use your DEPLOYED backend URL here ***
                    const LOGGING_BACKEND_URL_CALCULATE_QUOTE = `${BACKEND_BASE_URL}/log-calculated-quote`; 

                    const contactDetails = { name: document.getElementById('contactName')?.value || '', email: document.getElementById('contactEmail')?.value || '', phone: document.getElementById('contactPhone')?.value || '', company: document.getElementById('contactCompany')?.value || '' };
                    const packageGroups = document.querySelectorAll('.package-group');
                    let packagesData;
                    try {
                        packagesData = collectPackagesData();
                    } catch (collectionError) {
                        alert(collectionError.message || 'Please resolve package upload issues before continuing.');
                        return;
                    }
                    if (packagesData.length === 0) { alert("Error: Need package details for payment."); return; }
                    const serviceDetails = {
                        vehicleType: document.getElementById('vehicleType')?.value || '',
                        pickupDate: document.getElementById('pickupDate')?.value || '',
                        pickupTime: document.getElementById('pickupTime')?.value || '',
                        urgency: document.getElementById('urgency')?.value || '',
                        specialNotes: document.getElementById('specialNotes')?.value || '',
                        insideDelivery: document.getElementById('insideDelivery')?.checked || false,
                        hazardousBio: document.getElementById('hazardousBio')?.checked || false,
                        fragileHandling: document.getElementById('fragileHandling')?.checked || false,
                        extraLaborer: document.getElementById('extraLaborer')?.checked || false
                    };
                    const leadData = { contactDetails: contactDetails, stopsData: stopsData, packagesData: packagesData, serviceDetails: serviceDetails, totalMiles: calculatedTotalMiles, calculatedQuote: finalQuote };

                    console.log("Sending calculated quote data to backend:", JSON.stringify(leadData, null, 2));

                    fetch(LOGGING_BACKEND_URL_CALCULATE_QUOTE, {
                        method: 'POST',
                        cache: 'no-cache',
                        headers: { 'Content-Type': 'application/json', },
                        body: JSON.stringify(leadData),
                    })
                    .then(response => {
                        console.log('Backend calculated quote logging response status:', response.status);
                        if (!response.ok) {
                            return response.json().then(errData => {
                                throw new Error(`Backend logging failed: ${response.status} ${response.statusText} - ${errData.message || 'No details'}`);
                            }).catch(() => { throw new Error(`Backend logging failed: ${response.status} ${response.statusText}`); });
                        }
                        return response.json();
                    })
                    .then(result => {
                        console.log('Backend Calculated Quote Logging Response:', result);
                        if (result && result.status === 'success') { console.log('Calculated quote data successfully logged by backend.'); }
                        else { console.error('Backend reported an error logging calculated quote:', result ? result.message : 'Unknown error'); }
                    })
                    .catch(error => { console.error('Error sending calculated quote data to backend:', error); });
                } catch (logError) { console.error("Error preparing/sending calculated quote data to backend:", logError); }
            }
        }


        // ========== GENERATE SUMMARY TEXT ==========
        function generateSummaryText() {
            let summaryText = "Delivery Quote Summary\n========================\n\n";
            summaryText += "Contact Information:\n";
            summaryText += `  Name: ${document.getElementById('contactName')?.value || 'N/A'}\n`;
            summaryText += `  Email: ${document.getElementById('contactEmail')?.value || 'N/A'}\n`;
            const contactPhone = document.getElementById('contactPhone')?.value; if (contactPhone) summaryText += `  Phone: ${contactPhone}\n`;
            const contactCompany = document.getElementById('contactCompany')?.value; if (contactCompany) summaryText += `  Company: ${contactCompany}\n`;
            summaryText += "\nStops:\n";
            const stops = document.querySelectorAll('.address-group');
            if (stops.length < 2) { summaryText += "  (Not enough stops entered)\n"; }
            else { stops.forEach((stopGroup, i) => { const addressInput = stopGroup.querySelector('.stop-addr'); const loadUnloadSelect = stopGroup.querySelector('.load-unload-select'); const stairsCheck = stopGroup.querySelector('.stairs-check'); const floorInput = stopGroup.querySelector('.floor-count'); let addressText = addressInput ? addressInput.value : 'N/A'; summaryText += `  Stop ${i + 1}: ${addressText}\n`; let loadUnloadText = 'N/A'; if (loadUnloadSelect && loadUnloadSelect.selectedOptions.length > 0 && loadUnloadSelect.value !== "") loadUnloadText = loadUnloadSelect.selectedOptions[0].text; summaryText += `    Load/Unload: ${loadUnloadText}\n`; if (stairsCheck && stairsCheck.checked) { let floorValue = (floorInput && floorInput.value) ? floorInput.value : 'Not specified'; summaryText += `    Stairs: Yes, Floor: ${floorValue}\n`; } else { summaryText += `    Stairs: No\n`; } }); }
            summaryText += "\nPackages:\n";
            const packageGroups = document.querySelectorAll('.package-group');
            if (packageGroups.length === 0) { summaryText += "  (No packages added)\n"; }
            else {
              packageGroups.forEach((pkgGroup, j) => {
                const pkgQty = pkgGroup.querySelector('.pkg-qty')?.value || '1';
                const pkgDesc = pkgGroup.querySelector('.pkg-desc')?.value || 'N/A';
                const pkgWeight = pkgGroup.querySelector('.pkg-weight')?.value || '0';
                const pkgLength = pkgGroup.querySelector('.pkg-length')?.value || '0';
                const pkgWidth = pkgGroup.querySelector('.pkg-width')?.value || '0';
                const pkgHeight = pkgGroup.querySelector('.pkg-height')?.value || '0';
                const pkgUnit = pkgGroup.querySelector('.pkg-unit')?.value || 'inches';
                const attachmentMeta = getAttachmentMetaForInput(pkgGroup.querySelector('.pkg-upload'));
                let attachmentLabel = attachmentMeta.label || 'None';
                if (attachmentMeta.status === 'uploaded' && attachmentMeta.url) {
                  attachmentLabel = `${attachmentMeta.label} (${attachmentMeta.url})`;
                } else if (attachmentMeta.status === 'uploading') {
                  attachmentLabel = `Uploading: ${attachmentMeta.label}`;
                } else if (attachmentMeta.status === 'pending') {
                  attachmentLabel = `Pending upload: ${attachmentMeta.label}`;
                }
                summaryText += `  Package ${j+1} (${pkgQty}x): ${pkgDesc}\n`;
                summaryText += `    Wt(ea): ${pkgWeight} lbs, Dim(ea): ${pkgLength}x${pkgWidth}x${pkgHeight} ${pkgUnit}, Attachment: ${attachmentLabel}\n`;
              });
            }
            summaryText += "\nDetails & Services:\n";
            const vehicleTypeSelect = document.getElementById('vehicleType');
            const vehicleTypeText = vehicleTypeSelect.value ? vehicleTypeSelect.options[vehicleTypeSelect.selectedIndex].text : 'N/A';
            summaryText += `  Vehicle: ${vehicleTypeText}\n`;
            summaryText += `  Pickup Date/Time: ${document.getElementById('pickupDate').value || 'N/A'} ${document.getElementById('pickupTime').value || 'N/A'}\n`;
            const urgencySelect = document.getElementById('urgency');
            const urgencyText = urgencySelect.value ? urgencySelect.options[urgencySelect.selectedIndex].text : 'N/A';
            summaryText += `  Urgency: ${urgencyText}\n`; // Display text without fee
            summaryText += `  Special Notes: ${document.getElementById('specialNotes')?.value || 'None'}\n`;
            summaryText += `  Inside Delivery: ${document.getElementById('insideDelivery').checked ? 'Yes' : 'No'}\n`;
            summaryText += `  Hazardous/Bio-Hazardous: ${document.getElementById('hazardousBio').checked ? 'Yes' : 'No'}\n`; // Updated
            summaryText += `  Fragile/Special Handling: ${document.getElementById('fragileHandling').checked ? 'Yes' : 'No'}\n`; // New
            summaryText += `  Extra Laborer: ${document.getElementById('extraLaborer').checked ? 'Yes' : 'No'}\n`;
            summaryText += `  Total Distance: ${calculatedTotalMiles > 0 ? calculatedTotalMiles.toFixed(1) + ' miles' : 'Not Calculated'}\n`;
            
            const weightWarningEl = document.getElementById('weightWarning');
            if (weightWarningEl && weightWarningEl.style.display !== 'none') {
                summaryText += `\nWarning:\n  ${weightWarningEl.textContent}\n`;
            }

            summaryText += "\nQuote:\n";
            summaryText += `  ${document.getElementById('quoteResult').textContent || 'Not Calculated'}\n`;
            return summaryText;
        }


        // ========== DOWNLOAD SUMMARY FUNCTION ==========
        function downloadSummary() {
             console.log("Download summary requested.");
            try {
                const summaryContent = generateSummaryText();
                const blob = new Blob([summaryContent], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'delivery_summary.txt';
                document.body.appendChild(link); link.click(); document.body.removeChild(link);
                URL.revokeObjectURL(url);
                console.log("Summary download initiated.");
            } catch (error) {
                console.error("Error generating or downloading summary:", error);
                alert("Could not download summary. Please check the console for errors.");
            }
        }


        // ========== STRIPE PAYMENT LINK ==========
        async function handleBookNow() {
            console.log("Initiating Book Now process...");
            const bookBtn = document.getElementById('bookNowBtn');
            // --- Gather Data ---
            const stopGroups = document.querySelectorAll('.address-group'); const stopsDataForBackend = Array.from(stopGroups).map(group => ({ address: group.querySelector('.stop-addr')?.value.trim() || '', loadUnload: group.querySelector('.load-unload-select')?.value || '', stairs: group.querySelector('.stairs-check')?.checked || false, floor: group.querySelector('.floor-count')?.value || '' })).filter(stop => stop.address.length > 0);
            if (stopsDataForBackend.length < 2) { alert("Error: Need 2+ stops for payment."); return; }

            const packageGroups = document.querySelectorAll('.package-group');
            let packagesData;
            try {
                packagesData = collectPackagesData();
            } catch (collectionError) {
                alert(collectionError.message || 'Please resolve package upload issues before continuing.');
                return;
            }
            if (packagesData.length === 0) { alert("Error: Need package details for payment."); return; }

            const serviceDetails = {
                vehicleType: document.getElementById('vehicleType')?.value || '',
                pickupDate: document.getElementById('pickupDate')?.value || '',
                pickupTime: document.getElementById('pickupTime')?.value || '',
                urgency: document.getElementById('urgency')?.value || '',
                specialNotes: document.getElementById('specialNotes')?.value || '',
                insideDelivery: document.getElementById('insideDelivery')?.checked || false,
                hazardousBio: document.getElementById('hazardousBio')?.checked || false,
                fragileHandling: document.getElementById('fragileHandling')?.checked || false,
                extraLaborer: document.getElementById('extraLaborer')?.checked || false
            };
            if (!serviceDetails.vehicleType || !serviceDetails.pickupDate || !serviceDetails.pickupTime || !serviceDetails.urgency) { alert("Error: Missing service details."); return; }

            const customerEmail = document.getElementById('contactEmail')?.value || '';
            const customerName = document.getElementById('contactName')?.value || '';
            const customerPhone = document.getElementById('contactPhone')?.value || '';
            const customerCompany = document.getElementById('contactCompany')?.value || '';
            const contactDetails = { name: customerName, email: customerEmail, phone: customerPhone, company: customerCompany };
             if (!customerName) { alert("Error: Contact name required."); return; } if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) { alert("Error: Valid contact email required."); return; }

            const totalMiles = calculatedTotalMiles; if (typeof totalMiles !== 'number' || totalMiles < 0) { alert("Error: Distance not calculated."); return; }
            const quoteAmount = bookBtn.dataset.quoteAmount; if (!quoteAmount || isNaN(parseFloat(quoteAmount))) { alert("Error: Quote amount not available."); return; }

            // --- Prepare Fetch Request to /create-checkout-session ---
            bookBtn.textContent = 'Processing...'; bookBtn.disabled = true; document.getElementById('downloadSummaryBtn').disabled = true;
            try {
                // *** IMPORTANT: Use your DEPLOYED backend URL here ***
                const CHECKOUT_BACKEND_URL = `${BACKEND_BASE_URL}/create-checkout-session`; 

                console.log(`Attempting to fetch from: ${CHECKOUT_BACKEND_URL}`);
                const response = await fetch(CHECKOUT_BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contactDetails: contactDetails,
                        stopsData: stopsDataForBackend,
                        packagesData: packagesData,
                        serviceDetails: serviceDetails,
                        totalMiles: totalMiles,
                        calculatedQuote: parseFloat(quoteAmount)
                    }),
                });
                 if (!response.ok) {
                     let errorMsg = `Payment/Logging Error: ${response.status} ${response.statusText}`;
                     try { const errorData = await response.json(); errorMsg = errorData.error || errorMsg; }
                     catch(e) { console.warn("Could not parse error response body:", e); }
                     throw new Error(errorMsg);
                  }
                const session = await response.json();
                if (session.url) {
                    console.log("Redirecting to Stripe:", session.url);
                    window.location.href = session.url;
                } else {
                    throw new Error("Invalid response from server - no session URL received.")
                }
            } catch (error) {
                console.error('Checkout process failed:', error);
                alert('Error setting up payment: ' + (error?.message || 'Unknown error') + '.');
                bookBtn.textContent = 'Proceed to Payment';
                bookBtn.disabled = false;
                document.getElementById('downloadSummaryBtn').disabled = false;
            }
        }

        window.initializePackageUploadHandlers = initializePackageUploadHandlers;
        window.getAttachmentMetaForInput = getAttachmentMetaForInput;
        initializePackageUploadHandlers();
  
